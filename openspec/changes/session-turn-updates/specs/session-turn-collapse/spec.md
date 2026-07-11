# Session Turn Collapse Specification

## Purpose

Defines the collapse/expand behavior of turns in the session detail view
(`SessionDetailPage`). Because each turn's transcript is a superset of the
prior turn, only the newest turn carries new information; older turns MUST be
collapsed by default so users reach the latest exchange without scrolling past
duplicated history. Live polling continues unchanged.

## Requirements

### Requirement: Default Last-Turn-Expanded State

On initial render of a session, the system MUST expand only the last turn and
MUST collapse every prior turn. The last turn MUST remain expandable and MUST
NOT be collapsible below the default open state.

#### Scenario: Multi-turn session initial load

- GIVEN a session with N turns where N ≥ 2
- WHEN the session detail view first renders
- THEN turns `0..N-2` MUST render collapsed
- AND turn `N-1` (the last) MUST render expanded

#### Scenario: Single-turn session

- GIVEN a session with exactly 1 turn
- WHEN the view renders
- THEN that turn MUST render expanded
- AND no collapsible trigger is required for it

#### Scenario: Zero-turn session

- GIVEN a session with 0 turns
- WHEN the view renders
- THEN the system MUST render the existing empty/loading state
- AND MUST NOT error

### Requirement: Manual Expand and Collapse

The user MUST be able to toggle any previous turn between collapsed and
expanded independently. A user's manual toggle MUST persist for the lifetime of
the mounted view and MUST NOT be reset by unrelated re-renders.

#### Scenario: Expand a collapsed prior turn

- GIVEN a prior turn rendered collapsed
- WHEN the user activates its trigger (the turn's sticky header row)
- THEN that turn MUST expand
- AND other turns' states MUST remain unchanged

#### Scenario: Re-collapse a manually expanded turn

- GIVEN a prior turn the user previously expanded
- WHEN the user activates its trigger again
- THEN that turn MUST collapse

### Requirement: Live Update Turn Transition

The system MUST preserve the existing authenticated polling
(`refetchInterval: 10_000`). When polling yields a new last turn, the newly
arrived last turn MUST become expanded and the previously-last turn MUST
collapse to its default prior-turn state, UNLESS the user had manually expanded
that previous turn, in which case its user-chosen state MUST be preserved.

#### Scenario: New turn arrives via polling

- GIVEN the last turn `N-1` is expanded and the user has not toggled it
- WHEN a poll returns a new turn `N`
- THEN turn `N` MUST render expanded
- AND turn `N-1` MUST collapse

#### Scenario: New turn arrives while a prior turn is user-expanded

- GIVEN the user manually expanded an earlier turn `k`
- WHEN a poll returns a new last turn
- THEN turn `k` MUST remain expanded
- AND the new last turn MUST render expanded

#### Scenario: Poll returns no new turn

- GIVEN the current turns are rendered with their states
- WHEN a poll returns the same turn count with updated last-turn content
- THEN turn states MUST NOT change
- AND the last turn's updated content MUST render live

#### Scenario: Rapid successive updates

- GIVEN multiple polls add turns in quick succession
- WHEN each new last turn arrives
- THEN only the most recent turn MUST be auto-expanded
- AND each superseded last turn MUST collapse to its default state
- AND no more than one auto-expanded last turn MUST exist at a time
