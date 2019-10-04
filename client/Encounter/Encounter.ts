import * as ko from "knockout";
import { find, max, sortBy } from "lodash";
import * as React from "react";

import _ = require("lodash");
import { CombatStats } from "../../common/CombatStats";
import { CombatantState } from "../../common/CombatantState";
import { EncounterState } from "../../common/EncounterState";
import { PersistentCharacter } from "../../common/PersistentCharacter";
import { PlayerViewCombatantState } from "../../common/PlayerViewCombatantState";
import { AutoRerollInitiativeOption } from "../../common/Settings";
import { StatBlock } from "../../common/StatBlock";
import { probablyUniqueString } from "../../common/Toolbox";
import { Combatant } from "../Combatant/Combatant";
import { GetOrRollMaximumHP } from "../Combatant/GetOrRollMaximumHP";
import { ToPlayerViewCombatantState } from "../Combatant/ToPlayerViewCombatantState";
import { env } from "../Environment";
import {
  PersistentCharacterLibrary,
  PersistentCharacterUpdater
} from "../Library/PersistentCharacterLibrary";
import { PlayerViewClient } from "../Player/PlayerViewClient";
import { IRules } from "../Rules/Rules";
import { CurrentSettings } from "../Settings/Settings";
import { LegacySynchronousLocalStore } from "../Utility/LegacySynchronousLocalStore";
import {
  DifficultyCalculator,
  EncounterDifficulty
} from "../Widgets/DifficultyCalculator";
import { EncounterFlow } from "./EncounterFlow";

export class Encounter {
  public TemporaryBackgroundImageUrl = ko.observable<string>(null);

  private lastVisibleActiveCombatantId = null;

  constructor(
    private playerViewClient: PlayerViewClient,
    private promptEditCombatantInitiative: (combatantId: string) => void,
    public Rules: IRules
  ) {
    this.Difficulty = ko.pureComputed(() => {
      const enemyChallengeRatings = this.combatants()
        .filter(c => !c.IsPlayerCharacter())
        .filter(c => c.StatBlock().Challenge)
        .map(c => c.StatBlock().Challenge.toString());
      const playerLevels = this.combatants()
        .filter(c => c.IsPlayerCharacter())
        .filter(c => c.StatBlock().Challenge)
        .map(c => c.StatBlock().Challenge.toString());
      return DifficultyCalculator.Calculate(
        enemyChallengeRatings,
        playerLevels
      );
    });

    this.GetPlayerView.subscribe(newPlayerView => {
      if (!this.playerViewClient) {
        return;
      }
      this.playerViewClient.UpdateEncounter(env.EncounterId, newPlayerView);
    });
  }

  private combatants = ko.observableArray<Combatant>([]);
  public Combatants = ko.pureComputed(() => this.combatants());
  public CombatantCountsByName: KnockoutObservable<{
    [name: string]: number;
  }> = ko.observable({});
  public ActiveCombatantStatBlock: KnockoutComputed<React.ReactElement<any>>;
  public Difficulty: KnockoutComputed<EncounterDifficulty>;

  public EncounterFlow = new EncounterFlow(this);

  private getGroupBonusForCombatant(combatant: Combatant) {
    if (combatant.InitiativeGroup() == null) {
      return combatant.InitiativeBonus();
    }

    const groupBonuses = this.combatants()
      .filter(c => c.InitiativeGroup() == combatant.InitiativeGroup())
      .map(c => c.InitiativeBonus());

    return max(groupBonuses) || combatant.InitiativeBonus();
  }

  private getCombatantSortIteratees(
    stable: boolean
  ): ((c: Combatant) => number | string)[] {
    if (stable) {
      return [c => -c.Initiative()];
    } else {
      return [
        c => -c.Initiative(),
        c => -this.getGroupBonusForCombatant(c),
        c => -c.InitiativeBonus(),
        c => (c.IsPlayerCharacter() ? 0 : 1),
        c => c.InitiativeGroup(),
        c => c.StatBlock().Name,
        c => c.IndexLabel
      ];
    }
  }

  public SortByInitiative = (stable = false) => {
    const sortedCombatants = sortBy(
      this.combatants(),
      this.getCombatantSortIteratees(stable)
    );
    this.combatants(sortedCombatants);
  };

  public ImportEncounter = encounter => {
    const deepMerge = (a, b) => $.extend(true, {}, a, b);
    const defaultAdd = c => {
      if (c.TotalInitiativeModifier !== undefined) {
        c.InitiativeModifier = c.TotalInitiativeModifier;
      }
      this.AddCombatantFromStatBlock(deepMerge(StatBlock.Default(), c));
    };
    if (encounter.Combatants) {
      encounter.Combatants.forEach(c => {
        if (c.Player == "npc") {
          c.Player = "";
        }

        if (c.Id) {
          $.ajax(`/statblocks/${c.Id}`)
            .done(statBlockFromLibrary => {
              const modifiedStatBlockFromLibrary = deepMerge(
                statBlockFromLibrary,
                c
              );
              this.AddCombatantFromStatBlock(modifiedStatBlockFromLibrary);
            })
            .fail(_ => defaultAdd(c));
        } else {
          defaultAdd(c);
        }
      });
    }
  };

  public AddCombatantFromState = (combatantState: CombatantState) => {
    if (this.combatants().some(c => c.Id == combatantState.Id)) {
      combatantState.Id = probablyUniqueString();
    }

    const combatant = new Combatant(combatantState, this);
    this.combatants.push(combatant);

    combatant.UpdateIndexLabel();

    if (this.EncounterFlow.State() === "active") {
      this.promptEditCombatantInitiative(combatant.Id);
    }

    combatant.Tags().forEach(tag => {
      if (tag.HasDuration) {
        this.EncounterFlow.AddDurationTag(tag);
      }
    });

    return combatant;
  };

  public AddCombatantFromStatBlock = (statBlockJson: {}, hideOnAdd = false) => {
    const statBlock: StatBlock = { ...StatBlock.Default(), ...statBlockJson };
    statBlock.HP = {
      ...statBlock.HP,
      Value: GetOrRollMaximumHP(statBlock)
    };

    const initialState: CombatantState = {
      Id: probablyUniqueString(),
      StatBlock: statBlock,
      Alias: "",
      IndexLabel: null,
      CurrentHP: statBlock.HP.Value,
      TemporaryHP: 0,
      Hidden: hideOnAdd,
      RevealedAC: false,
      Initiative: 0,
      Tags: [],
      RoundCounter: 0,
      ElapsedSeconds: 0,
      InterfaceVersion: process.env.VERSION
    };

    const combatant = this.AddCombatantFromState(initialState);

    return combatant;
  };

  public CanAddCombatant = (persistentCharacterId: string) => {
    return !this.combatants().some(
      c => c.PersistentCharacterId == persistentCharacterId
    );
  };

  public AddCombatantFromPersistentCharacter(
    persistentCharacter: PersistentCharacter,
    library: PersistentCharacterUpdater,
    hideOnAdd = false
  ): Combatant {
    if (!this.CanAddCombatant(persistentCharacter.Id)) {
      return null;
    }

    const initialState: CombatantState = {
      Id: probablyUniqueString(),
      PersistentCharacterId: persistentCharacter.Id,
      StatBlock: persistentCharacter.StatBlock,
      Alias: "",
      IndexLabel: null,
      CurrentHP: persistentCharacter.CurrentHP,
      CurrentNotes: persistentCharacter.Notes,
      TemporaryHP: 0,
      Hidden: hideOnAdd,
      RevealedAC: false,
      Initiative: 0,
      Tags: [],
      RoundCounter: 0,
      ElapsedSeconds: 0,
      InterfaceVersion: persistentCharacter.Version
    };

    const combatant = this.AddCombatantFromState(initialState);

    combatant.AttachToPersistentCharacterLibrary(library);

    return combatant;
  }

  public RemoveCombatant = (combatant: Combatant) => {
    this.combatants.remove(combatant);

    const removedCombatantName = combatant.StatBlock().Name;
    const remainingCombatants = this.combatants();

    const allMyFriendsAreGone = remainingCombatants.every(
      c => c.StatBlock().Name != removedCombatantName
    );

    if (allMyFriendsAreGone) {
      const combatantCountsByName = this.CombatantCountsByName();
      delete combatantCountsByName[removedCombatantName];
      this.CombatantCountsByName(combatantCountsByName);
    }

    if (this.combatants().length == 0) {
      this.EncounterFlow.EndEncounter();
    }
  };

  public UpdatePersistentCharacterStatBlock(
    persistentCharacterId: string,
    newStatBlock: StatBlock
  ) {
    const combatant = find(
      this.combatants(),
      c => c.PersistentCharacterId == persistentCharacterId
    );
    if (!combatant) {
      return;
    }
    combatant.StatBlock(newStatBlock);
  }

  public MoveCombatant(combatant: Combatant, index: number) {
    combatant.InitiativeGroup(null);
    this.CleanInitiativeGroups();
    const currentPosition = this.combatants().indexOf(combatant);
    const passedCombatant = this.combatants()[index];
    const initiative = combatant.Initiative();
    let newInitiative = initiative;
    if (
      index > currentPosition &&
      passedCombatant &&
      passedCombatant.Initiative() < initiative
    ) {
      newInitiative = passedCombatant.Initiative();
    }
    if (
      index < currentPosition &&
      passedCombatant &&
      passedCombatant.Initiative() > initiative
    ) {
      newInitiative = passedCombatant.Initiative();
    }

    this.combatants.remove(combatant);
    this.combatants.splice(index, 0, combatant);
    combatant.Initiative(newInitiative);
    return newInitiative;
  }

  public CleanInitiativeGroups() {
    const combatants = this.combatants();
    combatants.forEach(combatant => {
      const group = combatant.InitiativeGroup();
      if (
        group &&
        combatants.filter(c => c.InitiativeGroup() === group).length < 2
      ) {
        combatant.InitiativeGroup(null);
      }
    });
  }

  public StartEncounterAutosaves = () => {
    this.GetEncounterState.subscribe(newState => {
      LegacySynchronousLocalStore.Save<EncounterState<CombatantState>>(
        LegacySynchronousLocalStore.AutoSavedEncounters,
        LegacySynchronousLocalStore.DefaultSavedEncounterId,
        newState
      );
    });
  };

  public GetEncounterState = ko.computed(
    (): EncounterState<CombatantState> => {
      let activeCombatant = this.EncounterFlow.ActiveCombatant();

      return {
        ActiveCombatantId: activeCombatant ? activeCombatant.Id : null,
        RoundCounter: this.EncounterFlow.CombatTimer.ElapsedRounds(),
        ElapsedSeconds: this.EncounterFlow.CombatTimer.ElapsedSeconds(),
        Combatants: this.combatants().map<CombatantState>(c => c.GetState()),
        BackgroundImageUrl: this.TemporaryBackgroundImageUrl()
      };
    }
  );

  public GetPlayerView = ko.computed(
    (): EncounterState<PlayerViewCombatantState> => {
      const activeCombatantId = this.getPlayerViewActiveCombatantId();
      const defaultBackgroundUrl = CurrentSettings().PlayerView.CustomStyles
        .backgroundUrl;
      return {
        ActiveCombatantId: activeCombatantId,
        RoundCounter: this.EncounterFlow.CombatTimer.ElapsedRounds(),
        Combatants: this.getCombatantsForPlayerView(activeCombatantId),
        BackgroundImageUrl:
          this.TemporaryBackgroundImageUrl() || defaultBackgroundUrl
      };
    }
  );

  public LoadEncounterState = (
    encounterState: EncounterState<CombatantState>,
    persistentCharacterLibrary: PersistentCharacterLibrary
  ) => {
    const savedEncounterIsActive = !!encounterState.ActiveCombatantId;
    const combatantsInLabelOrder = _.sortBy(
      encounterState.Combatants,
      c => c.IndexLabel
    );
    combatantsInLabelOrder.forEach(async savedCombatant => {
      if (this.combatants().some(c => c.Id == savedCombatant.Id)) {
        savedCombatant.Id = probablyUniqueString();
      }

      const combatant = this.AddCombatantFromState(savedCombatant);

      if (combatant.PersistentCharacterId) {
        const persistentCharacter = await persistentCharacterLibrary.GetPersistentCharacter(
          combatant.PersistentCharacterId
        );
        combatant.StatBlock(persistentCharacter.StatBlock);
        combatant.CurrentHP(persistentCharacter.CurrentHP);
        combatant.CurrentNotes(persistentCharacter.Notes);
        combatant.AttachToPersistentCharacterLibrary(
          persistentCharacterLibrary
        );
      }
    });

    if (savedEncounterIsActive) {
      this.EncounterFlow.State("active");
      this.EncounterFlow.ActiveCombatant(
        this.combatants()
          .filter(c => c.Id == encounterState.ActiveCombatantId)
          .pop()
      );
      this.EncounterFlow.ActiveCombatant().CombatTimer.Start();
      this.EncounterFlow.TurnTimer.Start();
      this.EncounterFlow.CombatTimer.Start();
    }
    this.EncounterFlow.CombatTimer.SetElapsedRounds(
      encounterState.RoundCounter || 1
    );
    this.EncounterFlow.CombatTimer.SetElapsedSeconds(
      encounterState.ElapsedSeconds || 0
    );
    this.TemporaryBackgroundImageUrl(encounterState.BackgroundImageUrl || null);
  };

  public ClearEncounter = () => {
    this.combatants([]);
    this.CombatantCountsByName({});
    this.EncounterFlow.EndEncounter();
  };

  private getPlayerViewActiveCombatantId() {
    const activeCombatant = this.EncounterFlow.ActiveCombatant();
    if (!activeCombatant) {
      this.lastVisibleActiveCombatantId = null;
      return this.lastVisibleActiveCombatantId;
    }

    if (activeCombatant.Hidden()) {
      return this.lastVisibleActiveCombatantId;
    }

    this.lastVisibleActiveCombatantId = activeCombatant.Id;

    return this.lastVisibleActiveCombatantId;
  }

  private getCombatantsForPlayerView(activeCombatantId: string) {
    const hideMonstersOutsideEncounter = CurrentSettings().PlayerView
      .HideMonstersOutsideEncounter;
    const combatants = this.combatants().filter(c => {
      if (c.Hidden()) {
        return false;
      }
      if (
        hideMonstersOutsideEncounter &&
        this.EncounterFlow.State() == "inactive" &&
        !c.IsPlayerCharacter()
      ) {
        return false;
      }
      return true;
    });

    const activeCombatantOnTop = CurrentSettings().PlayerView
      .ActiveCombatantOnTop;
    if (activeCombatantOnTop && activeCombatantId && combatants.length) {
      while (combatants[0].Id != activeCombatantId) {
        combatants.push(combatants.shift());
      }
    }

    return combatants.map<PlayerViewCombatantState>(c =>
      ToPlayerViewCombatantState(c)
    );
  }

  public DisplayPlayerViewCombatStats(stats: CombatStats) {
    this.playerViewClient.DisplayCombatStats(env.EncounterId, stats);
  }
}
