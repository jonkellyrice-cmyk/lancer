#Command: npm run patch
from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path
from typing import Any


SCRIPT_DIR = Path(__file__).resolve().parent
LANCER_ROOT = SCRIPT_DIR.parent
PATCH_FILE = SCRIPT_DIR / "filepatcher.json"


class PatchError(Exception):
    """Raised when a patch cannot be applied safely."""


def load_patch_file() -> dict[str, Any]:
    if not PATCH_FILE.exists():
        raise PatchError(f"Patch file not found: {PATCH_FILE}")

    try:
        data = json.loads(PATCH_FILE.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise PatchError(
            f"Invalid JSON in {PATCH_FILE.name}: "
            f"line {error.lineno}, column {error.colno}: {error.msg}"
        ) from error

    if not isinstance(data, dict):
        raise PatchError("The patch file root must be a JSON object.")

    return data


def resolve_target(relative_path: str) -> Path:
    if not relative_path:
        raise PatchError("A patch operation is missing its 'file' path.")

    target = (LANCER_ROOT / relative_path).resolve()

    try:
        target.relative_to(LANCER_ROOT.resolve())
    except ValueError as error:
        raise PatchError(
            f"Target path escapes the LANCER folder: {relative_path}"
        ) from error

    return target


def create_backup(target: Path) -> Path:
    backup = target.with_suffix(target.suffix + ".bak")
    shutil.copy2(target, backup)
    return backup


def apply_replace(text: str, operation: dict[str, Any]) -> str:
    find_text = operation.get("find")
    replacement = operation.get("replace")

    if not isinstance(find_text, str):
        raise PatchError("A replace operation requires a string 'find' value.")

    if not isinstance(replacement, str):
        raise PatchError(
            "A replace operation requires a string 'replace' value."
        )

    expected_matches = operation.get("expected_matches", 1)

    if not isinstance(expected_matches, int) or expected_matches < 1:
        raise PatchError("'expected_matches' must be a positive integer.")

    actual_matches = text.count(find_text)

    if actual_matches != expected_matches:
        raise PatchError(
            "Replace operation failed safety check: "
            f"expected {expected_matches} match(es), "
            f"found {actual_matches}."
        )

    return text.replace(find_text, replacement, expected_matches)


def apply_append(text: str, operation: dict[str, Any]) -> str:
    content = operation.get("content")

    if not isinstance(content, str):
        raise PatchError("An append operation requires string 'content'.")

    separator = "" if text.endswith("\n") or not text else "\n"
    return text + separator + content


def apply_prepend(text: str, operation: dict[str, Any]) -> str:
    content = operation.get("content")

    if not isinstance(content, str):
        raise PatchError("A prepend operation requires string 'content'.")

    separator = "" if content.endswith("\n") or not text else "\n"
    return content + separator + text


def apply_delete(text: str, operation: dict[str, Any]) -> str:
    find_text = operation.get("find")

    if not isinstance(find_text, str):
        raise PatchError("A delete operation requires a string 'find' value.")

    expected_matches = operation.get("expected_matches", 1)

    if not isinstance(expected_matches, int) or expected_matches < 1:
        raise PatchError("'expected_matches' must be a positive integer.")

    actual_matches = text.count(find_text)

    if actual_matches != expected_matches:
        raise PatchError(
            "Delete operation failed safety check: "
            f"expected {expected_matches} match(es), "
            f"found {actual_matches}."
        )

    return text.replace(find_text, "", expected_matches)


def apply_write(operation: dict[str, Any]) -> str:
    content = operation.get("content")

    if not isinstance(content, str):
        raise PatchError("A write operation requires string 'content'.")

    return content


def apply_operation(
    current_text: str,
    operation: dict[str, Any],
) -> str:
    operation_type = operation.get("operation")

    if operation_type == "replace":
        return apply_replace(current_text, operation)

    if operation_type == "append":
        return apply_append(current_text, operation)

    if operation_type == "prepend":
        return apply_prepend(current_text, operation)

    if operation_type == "delete":
        return apply_delete(current_text, operation)

    if operation_type == "write":
        return apply_write(operation)

    raise PatchError(
        f"Unsupported operation type: {operation_type!r}. "
        "Supported types are replace, append, prepend, delete, and write."
    )


def apply_patch_file(data: dict[str, Any]) -> None:
    patch_name = data.get("name", "Unnamed patch")
    make_backups = data.get("backup", True)
    operations = data.get("operations")

    if not isinstance(operations, list) or not operations:
        raise PatchError(
            "The patch JSON must contain a non-empty 'operations' array."
        )

    print(f"Applying patch: {patch_name}")
    print(f"LANCER root: {LANCER_ROOT}")
    print()

    grouped_operations: dict[Path, list[dict[str, Any]]] = {}

    for index, operation in enumerate(operations, start=1):
        if not isinstance(operation, dict):
            raise PatchError(f"Operation {index} must be a JSON object.")

        target = resolve_target(str(operation.get("file", "")))
        grouped_operations.setdefault(target, []).append(operation)

    staged_results: dict[Path, str] = {}

    for target, target_operations in grouped_operations.items():
        first_operation = target_operations[0]
        first_type = first_operation.get("operation")

        if target.exists():
            current_text = target.read_text(encoding="utf-8")
        elif first_type == "write":
            current_text = ""
        else:
            raise PatchError(f"Target file does not exist: {target}")

        updated_text = current_text

        for operation in target_operations:
            updated_text = apply_operation(updated_text, operation)

        staged_results[target] = updated_text

    for target, updated_text in staged_results.items():
        target.parent.mkdir(parents=True, exist_ok=True)

        if make_backups and target.exists():
            backup = create_backup(target)
            print(f"Backup: {backup.relative_to(LANCER_ROOT)}")

        target.write_text(updated_text, encoding="utf-8")
        print(f"Updated: {target.relative_to(LANCER_ROOT)}")

    print()
    print("Patch applied successfully.")


def main() -> int:
    try:
        patch_data = load_patch_file()
        apply_patch_file(patch_data)
        return 0
    except PatchError as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1
    except OSError as error:
        print(f"FILESYSTEM ERROR: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
