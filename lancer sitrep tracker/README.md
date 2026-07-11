# Lancer Sitrep Tracker

A Foundry VTT module for public, automated Lancer tactical-objective tracking.

## Version 1.0 features

- Gauntlet sitrep setup dialog
- Native Foundry Scene Region used as the control zone
- Public mission HUD visible to the GM and players
- Round countdown from the current round
- Automatic counts for:
  - allied units standing
  - hostile units standing
  - allied units in the zone
  - hostile units in the zone
- Defeated combatants are ignored
- Optional immediate victory for enemy elimination
- Optional immediate victory when allies already in the zone outnumber every surviving hostile
- Automatic final check when combat advances beyond the final round
- GM pause, victory, defeat, configure, and close controls
- State stored on the Combat document, so it survives refreshes and reconnects

## Requirements

- Foundry VTT 12 or 13
- Lancer system
- An active Combat encounter linked to the Scene
- At least one Scene Region drawn on the encounter map

## Installation on The Forge

1. Download `lancer-sitrep-tracker.zip`.
2. Open your Forge account and go to **My Foundry**.
3. Open the **Bazaar** or module-management area and use the option to install a module from a local ZIP/custom package, depending on your Forge interface.
4. Enable **Lancer Sitrep Tracker** in the world's **Manage Modules** screen.

For a locally hosted Foundry installation, extract the `lancer-sitrep-tracker` folder into:

`FoundryVTT/Data/modules/`

Restart Foundry, then enable the module in the world.

## Using the Gauntlet tracker

1. Open the battle Scene.
2. Use Foundry's **Region Controls** to draw a Region over the control zone.
3. Add all participating tokens to Combat.
4. Set player and allied units to **Friendly** token disposition.
5. Set enemy units to **Hostile** token disposition.
6. Start the Combat encounter.
7. In the Combat Tracker, click **Sitrep**.
8. Select the Region and choose the number of rounds.
9. Click **Begin Sitrep**.

The HUD updates when tokens move, combatants are created or removed, combatants are marked defeated, Regions change, or the round advances.

## Rules used

- Friendly disposition = allied unit
- Hostile disposition = enemy unit
- Neutral disposition = ignored
- A combatant marked defeated is not standing and does not count
- At the end of the final round, allies win only when at least one ally is in the zone and allied units in the zone outnumber hostile units in the zone
- The final check occurs as Foundry advances from the final round to the next round

## Console API

The module exposes:

```js
game.lancerSitrep.openSetup();
game.lancerSitrep.renderHUD();
game.lancerSitrep.calculateState();
game.lancerSitrep.end();
```

## Troubleshooting

Open the browser developer console with F12 and look for messages beginning with:

`lancer-sitrep-tracker |`

If the HUD says the Region cannot be found, make sure the Combat encounter belongs to the same Scene as the selected Region.
