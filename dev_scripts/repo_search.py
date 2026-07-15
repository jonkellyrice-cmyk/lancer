#!/usr/bin/env python3
"""
repo_context.py

Generate a targeted Markdown information packet from a source repository.

Designed for workflows where an AI writes JSON patch instructions but needs
precise, bounded context about the current repository before constructing them.

Examples:
    python dev_scripts/repo_context.py "token movement speed boost overcharge"
    python dev_scripts/repo_context.py --request "Add height to light sources" \
        --focus src/module.js src/settings.js
    npm run search -- "gauntlet control ultra elite grunt"

The script uses only the Python standard library. If ripgrep (`rg`) is
installed, it uses it for faster candidate discovery.
"""

from __future__ import annotations

import argparse
import fnmatch
import hashlib
import json
import os
import re
import subprocess
import sys
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, Sequence


DEFAULT_EXCLUDES = {
    ".git",
    ".hg",
    ".svn",
    ".idea",
    ".vscode",
    ".next",
    ".nuxt",
    ".svelte-kit",
    ".turbo",
    ".context-packets",
    ".cache",
    "node_modules",
    "vendor",
    "dist",
    "build",
    "coverage",
    "target",
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    "venv",
    ".venv",
    "env",
}

DEFAULT_BINARY_EXTENSIONS = {
    ".7z", ".a", ".avi", ".bin", ".bmp", ".class", ".dll", ".dmg", ".doc",
    ".docx", ".eot", ".exe", ".flac", ".gif", ".gz", ".ico", ".jar", ".jpeg",
    ".jpg", ".lockb", ".m4a", ".mkv", ".mov", ".mp3", ".mp4", ".o", ".obj",
    ".otf", ".pdf", ".png", ".pyc", ".pyd", ".so", ".sqlite", ".sqlite3",
    ".tar", ".tgz", ".ttf", ".wav", ".webm", ".webp", ".woff", ".woff2",
    ".xls", ".xlsx", ".zip",
}

SOURCE_EXTENSIONS = {
    ".c", ".cc", ".cpp", ".cs", ".css", ".go", ".h", ".hpp", ".html",
    ".java", ".js", ".jsx", ".json", ".kt", ".less", ".lua", ".md", ".mjs",
    ".mts", ".php", ".prisma", ".py", ".rb", ".rs", ".scss", ".sh", ".sql",
    ".svelte", ".swift", ".toml", ".ts", ".tsx", ".vue", ".xml", ".yaml",
    ".yml",
}

HIGH_VALUE_NAMES = {
    "package.json",
    "pyproject.toml",
    "requirements.txt",
    "Cargo.toml",
    "go.mod",
    "tsconfig.json",
    "jsconfig.json",
    "vite.config.js",
    "vite.config.ts",
    "next.config.js",
    "next.config.mjs",
    "next.config.ts",
    "foundryvtt.json",
    "module.json",
    "system.json",
    "README.md",
}

SYMBOL_PATTERNS = [
    re.compile(r"^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)"),
    re.compile(r"^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)"),
    re.compile(r"^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*="),
    re.compile(r"^\s*def\s+([A-Za-z_]\w*)\s*\("),
    re.compile(r"^\s*class\s+([A-Za-z_]\w*)\s*[:(]"),
    re.compile(r"^\s*(?:pub\s+)?fn\s+([A-Za-z_]\w*)\s*\("),
    re.compile(r"^\s*(?:(?:public|private|protected|internal|static|async)\s+)+[\w<>\[\],?]+\s+([A-Za-z_]\w*)\s*\("),
]

IMPORT_PATTERNS = [
    re.compile(r"""(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']"""),
    re.compile(r"""require\(\s*["']([^"']+)["']\s*\)"""),
    re.compile(r"""^\s*from\s+([.\w]+)\s+import\s+"""),
    re.compile(r"""^\s*import\s+([.\w]+)"""),
]


@dataclass
class Match:
    line: int
    text: str
    score: float


@dataclass
class FileResult:
    path: Path
    score: float = 0.0
    matches: list[Match] = field(default_factory=list)
    symbols: list[tuple[int, str]] = field(default_factory=list)
    imports: list[str] = field(default_factory=list)
    reasons: list[str] = field(default_factory=list)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Generate a targeted repository context packet."
    )
    parser.add_argument(
        "query",
        nargs="*",
        help="Search terms or a natural-language request.",
    )
    parser.add_argument(
        "--request",
        help="Explicit natural-language change request. Combined with positional query.",
    )
    parser.add_argument(
        "--root",
        default=".",
        help="Repository root. Defaults to the current directory.",
    )
    parser.add_argument(
        "--focus",
        nargs="*",
        default=[],
        help="Files or directories that should receive a ranking boost.",
    )
    parser.add_argument(
        "--include",
        action="append",
        default=[],
        help="Glob to include. Repeatable. Example: --include 'src/**/*.ts'",
    )
    parser.add_argument(
        "--exclude",
        action="append",
        default=[],
        help="Additional directory name or glob to exclude. Repeatable.",
    )
    parser.add_argument(
        "--max-files",
        type=int,
        default=18,
        help="Maximum number of source files in the packet. Default: 18.",
    )
    parser.add_argument(
        "--max-matches",
        type=int,
        default=8,
        help="Maximum direct matches shown per file. Default: 8.",
    )
    parser.add_argument(
        "--context",
        type=int,
        default=10,
        help="Context lines before and after a match. Default: 10.",
    )
    parser.add_argument(
        "--max-chars",
        type=int,
        default=120_000,
        help="Approximate output character budget. Default: 120000.",
    )
    parser.add_argument(
        "--tree-depth",
        type=int,
        default=4,
        help="Maximum repository tree depth. Default: 4.",
    )
    parser.add_argument(
        "--output",
        help="Output Markdown path. Default: .context-packets/<timestamp>-<slug>.md",
    )
    parser.add_argument(
        "--no-git",
        action="store_true",
        help="Do not include Git status and diff information.",
    )
    parser.add_argument(
        "--json-summary",
        action="store_true",
        help="Also write a compact adjacent JSON summary.",
    )
    return parser.parse_args()


def run_command(
    command: Sequence[str],
    cwd: Path,
    timeout: int = 20,
) -> tuple[int, str, str]:
    try:
        completed = subprocess.run(
            command,
            cwd=cwd,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
            check=False,
            errors="replace",
        )
        return completed.returncode, completed.stdout, completed.stderr
    except (OSError, subprocess.SubprocessError) as exc:
        return 1, "", str(exc)


def discover_root(start: Path) -> Path:
    start = start.resolve()
    markers = {".git", "package.json", "pyproject.toml", "Cargo.toml", "go.mod"}
    for candidate in [start, *start.parents]:
        if any((candidate / marker).exists() for marker in markers):
            return candidate
    return start


def is_excluded(path: Path, root: Path, exclusions: set[str], globs: list[str]) -> bool:
    try:
        relative = path.relative_to(root)
    except ValueError:
        return True

    if any(part in exclusions for part in relative.parts):
        return True

    relative_posix = relative.as_posix()
    return any(
        fnmatch.fnmatch(relative_posix, pattern)
        or fnmatch.fnmatch(path.name, pattern)
        for pattern in globs
    )


def is_probably_text(path: Path) -> bool:
    if path.suffix.lower() in DEFAULT_BINARY_EXTENSIONS:
        return False
    try:
        with path.open("rb") as handle:
            chunk = handle.read(4096)
    except OSError:
        return False
    return b"\x00" not in chunk


def included_by_glob(path: Path, root: Path, includes: list[str]) -> bool:
    if not includes:
        return True
    rel = path.relative_to(root).as_posix()
    return any(fnmatch.fnmatch(rel, pattern) for pattern in includes)


def iter_source_files(
    root: Path,
    extra_excludes: list[str],
    includes: list[str],
) -> Iterable[Path]:
    exclusion_names = set(DEFAULT_EXCLUDES)
    exclusion_globs: list[str] = []
    for item in extra_excludes:
        if any(char in item for char in "*?[]") or "/" in item or "\\" in item:
            exclusion_globs.append(item.replace("\\", "/"))
        else:
            exclusion_names.add(item)

    for current_root, dirnames, filenames in os.walk(root):
        current = Path(current_root)
        dirnames[:] = sorted(
            dirname
            for dirname in dirnames
            if not is_excluded(current / dirname, root, exclusion_names, exclusion_globs)
        )

        for filename in sorted(filenames):
            path = current / filename
            if is_excluded(path, root, exclusion_names, exclusion_globs):
                continue
            if not included_by_glob(path, root, includes):
                continue
            if path.name in HIGH_VALUE_NAMES or path.suffix.lower() in SOURCE_EXTENSIONS:
                if is_probably_text(path):
                    yield path


def tokenize_query(text: str) -> list[str]:
    raw = re.findall(r"[A-Za-z_$][A-Za-z0-9_$.-]{1,}", text)
    stopwords = {
        "a", "an", "and", "are", "as", "at", "be", "because", "but", "by",
        "can", "code", "could", "do", "does", "edit", "file", "for", "from",
        "generate", "have", "i", "in", "into", "is", "it", "make", "need",
        "of", "on", "or", "patch", "repo", "script", "should", "so", "that",
        "the", "their", "then", "this", "to", "uses", "want", "will", "with",
        "you",
    }
    terms: list[str] = []
    seen: set[str] = set()
    for token in raw:
        normalized = token.lower().strip(".-_")
        if len(normalized) < 2 or normalized in stopwords or normalized in seen:
            continue
        seen.add(normalized)
        terms.append(normalized)
    return terms


def read_lines(path: Path) -> list[str]:
    try:
        return path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return []


def find_symbols(lines: list[str]) -> list[tuple[int, str]]:
    symbols: list[tuple[int, str]] = []
    for index, line in enumerate(lines, start=1):
        for pattern in SYMBOL_PATTERNS:
            match = pattern.search(line)
            if match:
                symbols.append((index, match.group(1)))
                break
    return symbols


def find_imports(lines: list[str]) -> list[str]:
    imports: list[str] = []
    for line in lines:
        for pattern in IMPORT_PATTERNS:
            for match in pattern.finditer(line):
                value = match.group(1)
                if value not in imports:
                    imports.append(value)
    return imports[:80]


def focus_score(path: Path, root: Path, focus_items: list[str]) -> float:
    if not focus_items:
        return 0.0
    relative = path.relative_to(root).as_posix().lower()
    score = 0.0
    for item in focus_items:
        needle = item.replace("\\", "/").strip("./").lower()
        if relative == needle:
            score += 40
        elif relative.startswith(needle.rstrip("/") + "/"):
            score += 25
        elif needle in relative:
            score += 12
    return score


def rank_files(
    files: list[Path],
    root: Path,
    terms: list[str],
    request: str,
    focus_items: list[str],
) -> list[FileResult]:
    results: list[FileResult] = []
    request_lower = request.lower()

    for path in files:
        lines = read_lines(path)
        if not lines:
            continue

        rel = path.relative_to(root).as_posix()
        rel_lower = rel.lower()
        symbols = find_symbols(lines)
        imports = find_imports(lines)
        result = FileResult(path=path, symbols=symbols, imports=imports)

        result.score += focus_score(path, root, focus_items)

        # The context generator itself contains generic search vocabulary in its
        # documentation. Keep it searchable when explicitly requested, but stop it
        # from crowding out the application code in ordinary packets.
        if path.resolve() == Path(__file__).resolve() and not any(
            term in {"repo_context", "context", "packet", "search"}
            for term in terms
        ):
            result.score -= 60
            result.reasons.append("context-generator self-match penalty")

        if path.name in HIGH_VALUE_NAMES:
            result.score += 3
            result.reasons.append("repository configuration or documentation")

        for term in terms:
            if term in path.stem.lower():
                result.score += 14
                result.reasons.append(f"filename matches `{term}`")
            elif term in rel_lower:
                result.score += 7

        symbol_names = {name.lower(): line for line, name in symbols}
        for term in terms:
            for symbol_name, line_no in symbol_names.items():
                if term == symbol_name:
                    result.score += 18
                    result.reasons.append(f"defines symbol `{symbol_name}`")
                elif term in symbol_name:
                    result.score += 9

        term_patterns = [
            (term, re.compile(re.escape(term), re.IGNORECASE))
            for term in terms
        ]
        for index, line in enumerate(lines, start=1):
            line_lower = line.lower()
            line_score = 0.0
            hits = 0
            for term, pattern in term_patterns:
                count = len(pattern.findall(line))
                if count:
                    hits += 1
                    line_score += min(count, 3) * 2.5
                    if re.search(rf"\b{re.escape(term)}\b", line, re.IGNORECASE):
                        line_score += 1.5

            if hits >= 2:
                line_score += hits * 2
            if request_lower and len(request_lower) <= 120 and request_lower in line_lower:
                line_score += 20

            if line_score:
                result.matches.append(Match(index, line.rstrip(), line_score))
                result.score += line_score

        result.matches.sort(key=lambda match: (-match.score, match.line))
        if result.matches:
            result.reasons.append(f"{len(result.matches)} matching line(s)")

        # Prevent very large generated or minified files from dominating.
        size = path.stat().st_size
        if size > 500_000:
            result.score *= 0.45
            result.reasons.append("large file penalty")
        if any(len(line) > 1000 for line in lines[:100]):
            result.score *= 0.55
            result.reasons.append("possible generated/minified file penalty")

        if result.score > 0:
            results.append(result)

    results.sort(
        key=lambda result: (
            -result.score,
            result.path.relative_to(root).as_posix(),
        )
    )
    return results


def resolve_relative_import(
    importer: Path,
    import_value: str,
    root: Path,
    file_set: set[Path],
) -> Path | None:
    if not import_value.startswith("."):
        return None

    base = (importer.parent / import_value).resolve()
    candidates = [base]
    for extension in (
        ".ts", ".tsx", ".js", ".jsx", ".mjs", ".mts", ".py", ".json",
        ".css", ".scss", ".vue", ".svelte",
    ):
        candidates.append(Path(str(base) + extension))
    for index_name in (
        "index.ts", "index.tsx", "index.js", "index.jsx", "__init__.py",
    ):
        candidates.append(base / index_name)

    for candidate in candidates:
        try:
            candidate = candidate.resolve()
            candidate.relative_to(root)
        except (OSError, ValueError):
            continue
        if candidate in file_set:
            return candidate
    return None


def expand_dependencies(
    ranked: list[FileResult],
    files: list[Path],
    root: Path,
    selected_limit: int,
) -> tuple[list[FileResult], dict[Path, set[Path]], dict[Path, set[Path]]]:
    file_set = {path.resolve() for path in files}
    by_path = {result.path.resolve(): result for result in ranked}
    imports_map: dict[Path, set[Path]] = defaultdict(set)
    reverse_map: dict[Path, set[Path]] = defaultdict(set)

    # Parse all files so reverse dependencies can be discovered.
    all_imports: dict[Path, list[str]] = {}
    for path in files:
        all_imports[path.resolve()] = find_imports(read_lines(path))

    for importer, import_values in all_imports.items():
        for import_value in import_values:
            target = resolve_relative_import(importer, import_value, root, file_set)
            if target:
                imports_map[importer].add(target)
                reverse_map[target].add(importer)

    selected = ranked[:selected_limit]
    selected_paths = {result.path.resolve() for result in selected}

    # Add one dependency and one reverse-dependency layer for strong candidates.
    extras: list[tuple[float, Path, str]] = []
    for result in selected[: min(8, len(selected))]:
        source = result.path.resolve()
        for dependency in imports_map.get(source, set()):
            if dependency not in selected_paths:
                extras.append((result.score * 0.22 + 4, dependency, f"imported by {source.name}"))
        for dependent in reverse_map.get(source, set()):
            if dependent not in selected_paths:
                extras.append((result.score * 0.18 + 3, dependent, f"imports {source.name}"))

    for score, path, reason in sorted(extras, key=lambda item: -item[0]):
        if len(selected) >= selected_limit:
            break
        if path in selected_paths:
            continue
        result = by_path.get(path)
        if result is None:
            lines = read_lines(path)
            result = FileResult(
                path=path,
                score=score,
                symbols=find_symbols(lines),
                imports=find_imports(lines),
                reasons=[reason],
            )
        else:
            result.score = max(result.score, score)
            result.reasons.append(reason)
        selected.append(result)
        selected_paths.add(path)

    return selected, imports_map, reverse_map


def merge_windows(
    line_numbers: list[int],
    line_count: int,
    context: int,
) -> list[tuple[int, int]]:
    windows: list[tuple[int, int]] = []
    for line_number in sorted(set(line_numbers)):
        start = max(1, line_number - context)
        end = min(line_count, line_number + context)
        if windows and start <= windows[-1][1] + 2:
            windows[-1] = (windows[-1][0], max(windows[-1][1], end))
        else:
            windows.append((start, end))
    return windows


def choose_excerpt_windows(
    result: FileResult,
    lines: list[str],
    max_matches: int,
    context: int,
) -> list[tuple[int, int]]:
    match_lines = [match.line for match in result.matches[:max_matches]]

    # Include nearby symbol declarations, especially when direct matches are sparse.
    if match_lines:
        for symbol_line, _ in result.symbols:
            if any(abs(symbol_line - match_line) <= 40 for match_line in match_lines):
                match_lines.append(symbol_line)
    elif result.symbols:
        match_lines.extend(line for line, _ in result.symbols[:3])
    else:
        match_lines.append(1)

    return merge_windows(match_lines, len(lines), context)


def fenced_language(path: Path) -> str:
    mapping = {
        ".js": "javascript", ".jsx": "jsx", ".mjs": "javascript",
        ".ts": "typescript", ".tsx": "tsx", ".mts": "typescript",
        ".py": "python", ".json": "json", ".md": "markdown",
        ".yaml": "yaml", ".yml": "yaml", ".toml": "toml",
        ".css": "css", ".scss": "scss", ".html": "html",
        ".sh": "bash", ".rs": "rust", ".go": "go", ".java": "java",
        ".cs": "csharp", ".cpp": "cpp", ".c": "c",
    }
    return mapping.get(path.suffix.lower(), "text")


def format_numbered_excerpt(
    lines: list[str],
    start: int,
    end: int,
) -> str:
    width = len(str(end))
    return "\n".join(
        f"{line_number:>{width}} | {lines[line_number - 1]}"
        for line_number in range(start, end + 1)
    )


def build_tree(
    root: Path,
    files: list[Path],
    max_depth: int,
    max_entries: int = 350,
) -> str:
    paths = sorted(path.relative_to(root) for path in files)
    entries: list[str] = []
    seen_dirs: set[Path] = set()

    for relative in paths:
        parts = relative.parts
        for depth in range(min(len(parts) - 1, max_depth)):
            directory = Path(*parts[: depth + 1])
            if directory not in seen_dirs:
                indent = "  " * depth
                entries.append(f"{indent}{directory.name}/")
                seen_dirs.add(directory)
                if len(entries) >= max_entries:
                    return "\n".join(entries + ["… tree truncated …"])

        if len(parts) <= max_depth:
            indent = "  " * (len(parts) - 1)
            entries.append(f"{indent}{parts[-1]}")
            if len(entries) >= max_entries:
                return "\n".join(entries + ["… tree truncated …"])

    return "\n".join(entries)


def git_information(root: Path) -> dict[str, str]:
    info: dict[str, str] = {}
    code, top, _ = run_command(["git", "rev-parse", "--show-toplevel"], root)
    if code != 0:
        return info

    commands = {
        "branch": ["git", "branch", "--show-current"],
        "commit": ["git", "rev-parse", "--short", "HEAD"],
        "status": ["git", "status", "--short"],
        "diff_stat": ["git", "diff", "--stat"],
        "diff": ["git", "diff", "--no-ext-diff", "--unified=3"],
        "staged_diff": ["git", "diff", "--cached", "--no-ext-diff", "--unified=3"],
    }
    for key, command in commands.items():
        _, stdout, _ = run_command(command, root)
        info[key] = stdout.strip()
    return info


def package_metadata(root: Path) -> dict[str, object]:
    package_path = root / "package.json"
    if not package_path.exists():
        return {}
    try:
        package = json.loads(package_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return {
        "name": package.get("name"),
        "version": package.get("version"),
        "type": package.get("type"),
        "scripts": package.get("scripts", {}),
        "dependencies": sorted((package.get("dependencies") or {}).keys()),
        "devDependencies": sorted((package.get("devDependencies") or {}).keys()),
    }


def slugify(text: str, limit: int = 50) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return (slug[:limit].rstrip("-") or "context")


def redact_home(path: Path) -> str:
    try:
        home = Path.home().resolve()
        resolved = path.resolve()
        return "~/" + resolved.relative_to(home).as_posix()
    except (ValueError, OSError):
        return path.as_posix()


def append_with_budget(parts: list[str], text: str, budget: int) -> bool:
    current = sum(len(part) for part in parts)
    if current + len(text) > budget:
        return False
    parts.append(text)
    return True


def generate_packet(
    root: Path,
    request: str,
    terms: list[str],
    files: list[Path],
    selected: list[FileResult],
    imports_map: dict[Path, set[Path]],
    reverse_map: dict[Path, set[Path]],
    args: argparse.Namespace,
) -> tuple[str, dict[str, object]]:
    generated_at = datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")
    git = {} if args.no_git else git_information(root)
    package = package_metadata(root)

    parts: list[str] = []
    parts.append("# Repository Context Packet\n\n")
    parts.append("## Request\n\n")
    parts.append(f"{request}\n\n")
    parts.append("## Packet Metadata\n\n")
    parts.append(f"- Generated: `{generated_at}`\n")
    parts.append(f"- Repository root: `{redact_home(root)}`\n")
    if git:
        parts.append(f"- Git branch: `{git.get('branch') or '(detached/unknown)'}`\n")
        parts.append(f"- Git commit: `{git.get('commit') or 'unknown'}`\n")
    parts.append(f"- Query terms: `{', '.join(terms) if terms else '(none)'}`\n")
    parts.append(f"- Source files scanned: `{len(files)}`\n")
    parts.append(f"- Files selected: `{len(selected)}`\n\n")

    parts.append("## Instructions for the Patch Author\n\n")
    parts.append(
        "Use this packet as evidence of the repository's current state. "
        "Do not assume omitted code is unchanged or compatible. Prefer exact anchors "
        "shown below, preserve local conventions, and request another packet when an "
        "unshown definition, caller, schema, template, or test is material to the patch.\n\n"
    )

    parts.append("## Repository Structure\n\n```text\n")
    parts.append(build_tree(root, files, args.tree_depth))
    parts.append("\n```\n\n")

    if package:
        parts.append("## Package Metadata\n\n")
        parts.append("```json\n")
        parts.append(json.dumps(package, indent=2, ensure_ascii=False))
        parts.append("\n```\n\n")

    if git:
        parts.append("## Working Tree State\n\n")
        parts.append("### Status\n\n```text\n")
        parts.append(git.get("status") or "(clean)")
        parts.append("\n```\n\n")
        if git.get("diff_stat"):
            parts.append("### Unstaged Diff Stat\n\n```text\n")
            parts.append(git["diff_stat"])
            parts.append("\n```\n\n")

    parts.append("## Ranked Files\n\n")
    for index, result in enumerate(selected, start=1):
        rel = result.path.relative_to(root).as_posix()
        reason_text = "; ".join(dict.fromkeys(result.reasons)) or "dependency context"
        parts.append(f"{index}. `{rel}` — score `{result.score:.1f}` — {reason_text}\n")
    parts.append("\n")

    parts.append("## Dependency Clues\n\n")
    selected_paths = {result.path.resolve() for result in selected}
    dependency_lines = 0
    for result in selected:
        source = result.path.resolve()
        outgoing = sorted(
            target.relative_to(root).as_posix()
            for target in imports_map.get(source, set())
            if target in selected_paths
        )
        incoming = sorted(
            importer.relative_to(root).as_posix()
            for importer in reverse_map.get(source, set())
            if importer in selected_paths
        )
        if outgoing or incoming:
            rel = result.path.relative_to(root).as_posix()
            parts.append(f"- `{rel}`\n")
            if outgoing:
                parts.append(f"  - imports: {', '.join(f'`{item}`' for item in outgoing)}\n")
            if incoming:
                parts.append(f"  - imported by: {', '.join(f'`{item}`' for item in incoming)}\n")
            dependency_lines += 1
    if dependency_lines == 0:
        parts.append("- No resolvable relative dependency edges among selected files.\n")
    parts.append("\n")

    if git and (git.get("diff") or git.get("staged_diff")):
        diff_text = ""
        if git.get("diff"):
            diff_text += "### Unstaged Diff\n\n```diff\n" + git["diff"] + "\n```\n\n"
        if git.get("staged_diff"):
            diff_text += "### Staged Diff\n\n```diff\n" + git["staged_diff"] + "\n```\n\n"
        # Reserve at most roughly one quarter of the budget for current diffs.
        if len(diff_text) > args.max_chars // 4:
            diff_text = diff_text[: args.max_chars // 4] + "\n… diff truncated …\n```\n\n"
        parts.append("## Existing Changes\n\n")
        parts.append(diff_text)

    parts.append("## Relevant Source Excerpts\n\n")
    truncated_files: list[str] = []
    included_files: list[str] = []

    for result in selected:
        rel = result.path.relative_to(root).as_posix()
        lines = read_lines(result.path)
        if not lines:
            continue

        section: list[str] = [f"### `{rel}`\n\n"]
        if result.symbols:
            shown_symbols = ", ".join(
                f"`{name}` (L{line})" for line, name in result.symbols[:20]
            )
            section.append(f"Symbols: {shown_symbols}\n\n")
        if result.imports:
            section.append(
                "Imports/modules: "
                + ", ".join(f"`{item}`" for item in result.imports[:20])
                + "\n\n"
            )

        windows = choose_excerpt_windows(
            result,
            lines,
            args.max_matches,
            args.context,
        )
        language = fenced_language(result.path)
        for start, end in windows:
            section.append(f"Lines {start}-{end}:\n\n```{language}\n")
            section.append(format_numbered_excerpt(lines, start, end))
            section.append("\n```\n\n")

        section_text = "".join(section)
        if append_with_budget(parts, section_text, args.max_chars):
            included_files.append(rel)
        else:
            truncated_files.append(rel)
            break

    if truncated_files:
        parts.append("## Truncation Notice\n\n")
        parts.append(
            "The character budget was reached before every selected excerpt could be "
            "included. Re-run with a narrower query, explicit `--focus` paths, or a "
            "larger `--max-chars` value.\n\n"
        )
        parts.append(
            "First omitted file: `" + truncated_files[0] + "`\n\n"
        )

    packet = "".join(parts)
    digest = hashlib.sha256(packet.encode("utf-8")).hexdigest()[:16]
    packet += f"---\nPacket SHA-256 prefix: `{digest}`\n"

    summary: dict[str, object] = {
        "request": request,
        "generated_at": generated_at,
        "root": str(root),
        "query_terms": terms,
        "files_scanned": len(files),
        "files_selected": [
            {
                "path": result.path.relative_to(root).as_posix(),
                "score": round(result.score, 2),
                "reasons": list(dict.fromkeys(result.reasons)),
            }
            for result in selected
        ],
        "files_included": included_files,
        "packet_sha256_prefix": digest,
        "git": {
            "branch": git.get("branch"),
            "commit": git.get("commit"),
            "dirty": bool(git.get("status")),
        } if git else None,
    }
    return packet, summary


def main() -> int:
    args = parse_args()
    request_parts = []
    if args.request:
        request_parts.append(args.request.strip())
    if args.query:
        request_parts.append(" ".join(args.query).strip())
    request = " ".join(part for part in request_parts if part).strip()

    if not request:
        print(
            "error: provide a positional query or --request text",
            file=sys.stderr,
        )
        return 2
    if args.max_files < 1 or args.max_matches < 1 or args.context < 0:
        print("error: invalid numeric limit", file=sys.stderr)
        return 2

    root = discover_root(Path(args.root))
    terms = tokenize_query(request)
    files = list(iter_source_files(root, args.exclude, args.include))
    if not files:
        print(f"error: no source files found under {root}", file=sys.stderr)
        return 1

    ranked = rank_files(files, root, terms, request, args.focus)
    if not ranked:
        # Still provide high-value files when the query has no textual matches.
        fallback_paths = [
            path for path in files
            if path.name in HIGH_VALUE_NAMES
        ][: args.max_files]
        ranked = [
            FileResult(
                path=path,
                score=1.0,
                symbols=find_symbols(read_lines(path)),
                imports=find_imports(read_lines(path)),
                reasons=["fallback repository context"],
            )
            for path in fallback_paths
        ]

    selected, imports_map, reverse_map = expand_dependencies(
        ranked,
        files,
        root,
        args.max_files,
    )
    packet, summary = generate_packet(
        root,
        request,
        terms,
        files,
        selected,
        imports_map,
        reverse_map,
        args,
    )

    if args.output:
        output_path = Path(args.output)
        if not output_path.is_absolute():
            output_path = root / output_path
    else:
        timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        output_path = (
            root
            / ".context-packets"
            / f"{timestamp}-{slugify(request)}.md"
        )

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(packet, encoding="utf-8")

    if args.json_summary:
        json_path = output_path.with_suffix(".json")
        json_path.write_text(
            json.dumps(summary, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
        print(f"JSON summary: {json_path.relative_to(root)}")

    print(f"Context packet: {output_path.relative_to(root)}")
    print(f"Scanned {len(files)} files; selected {len(selected)}.")
    print("Share the generated Markdown packet with the patch author.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
