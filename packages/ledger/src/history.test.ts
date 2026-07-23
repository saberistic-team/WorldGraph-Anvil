import { describe, expect, it } from 'vitest';

import {
  projectWorldHistoryEntryV1,
  projectCommandWorldHistoryEntryV1,
  redactCommandForHistoryV1,
  renderWorldHistoryTitleV1,
  visibleWorldHistoryEntriesV1,
} from './history.js';
import { createFixtureCommand, createFixtureLedger } from './test-fixture.js';

describe('deterministic redacted history', () => {
  it('projects only allowlisted fields through a localized template key', () => {
    const fixture = createFixtureLedger();
    const event = fixture.events[1]!;
    const ledger = fixture.entries[2]!;
    const history = projectWorldHistoryEntryV1(event, ledger);
    expect(history).toMatchObject({
      category: 'entity',
      ledgerSequence: '3',
      summaryArgs: {
        entityKey: 'district:harbor',
        entityType: 'district',
        newDisplayName: 'New Harbor',
        previousDisplayName: 'Old Harbor',
      },
      targetId: 'district:harbor',
      targetType: 'world_entity',
      titleKey: 'history.entity.renamed',
      visibility: 'member',
    });
    expect(renderWorldHistoryTitleV1(history)).toBe(
      'district district:harbor was renamed to New Harbor.',
    );
  });

  it('redacts command payload content to identifiers, versions and a hash', () => {
    const details = redactCommandForHistoryV1(createFixtureCommand(), 'f'.repeat(64));
    expect(details).toEqual({
      commandType: 'RenameWorldEntityV1',
      entityKey: 'district:harbor',
      expectedAggregateVersion: '1',
      expectedStateRevision: '0',
      expectedWorldVersion: '1',
      payloadHash: 'f'.repeat(64),
    });
    expect(JSON.stringify(details)).not.toContain('New Harbor');
    expect(JSON.stringify(details)).not.toContain('actorId');
  });

  it('projects command acceptance separately without exposing its display-name payload', () => {
    const fixture = createFixtureLedger();
    const command = createFixtureCommand();
    const history = projectCommandWorldHistoryEntryV1(
      command,
      {
        commandId: command.commandId,
        eventIds: [fixture.events[1]!.eventId],
        eventSequenceRange: { from: '2', to: '2' },
        ledgerSequenceRange: { from: '2', to: '3' },
        resultingStateRevision: '1',
        schemaVersion: 1,
        status: 'accepted',
      },
      fixture.entries[1]!,
    );
    expect(history).toMatchObject({
      category: 'command',
      summaryArgs: { commandType: 'RenameWorldEntityV1', entityKey: 'district:harbor' },
      titleKey: 'history.command.accepted',
    });
    expect(JSON.stringify(history)).not.toContain('New Harbor');
  });

  it('renders creator-visible rejection history from stable codes without payload content', () => {
    const fixture = createFixtureLedger();
    const command = createFixtureCommand();
    const rejectedEntry = {
      ...fixture.entries[1]!,
      commandId: command.commandId,
      entryKind: 'command_rejected' as const,
      eventId: null,
      publicSummaryCode: 'COMMAND_REJECTED',
    };
    const history = projectCommandWorldHistoryEntryV1(
      command,
      {
        commandId: command.commandId,
        currentStateRevision: '1',
        eventIds: [],
        rejectionCode: 'REVISION_CONFLICT',
        schemaVersion: 1,
        status: 'rejected',
      },
      rejectedEntry,
    );
    expect(history).toMatchObject({
      resultingStateRevision: null,
      summaryArgs: {
        commandType: 'RenameWorldEntityV1',
        entityKey: 'district:harbor',
        rejectionCode: 'REVISION_CONFLICT',
      },
      titleKey: 'history.command.rejected',
      visibility: 'creator',
    });
    expect(renderWorldHistoryTitleV1(history)).toBe(
      'RenameWorldEntityV1 was rejected with REVISION_CONFLICT.',
    );
    expect(JSON.stringify(history)).not.toContain('New Harbor');
  });

  it('filters hidden rows before pagination and never returns placeholders', () => {
    const fixture = createFixtureLedger();
    const member = projectWorldHistoryEntryV1(fixture.events[1]!, fixture.entries[2]!);
    const creator = { ...member, ledgerSequence: '4', visibility: 'creator' as const };
    const operator = { ...member, ledgerSequence: '5', visibility: 'operator' as const };
    const participant = { ...member, ledgerSequence: '6', visibility: 'participant' as const };
    expect(
      visibleWorldHistoryEntriesV1([member, creator, operator, participant], 'member'),
    ).toEqual([member]);
    expect(
      visibleWorldHistoryEntriesV1([member, creator, operator, participant], 'creator'),
    ).toEqual([member, creator]);
    expect(
      visibleWorldHistoryEntriesV1([member, creator, operator, participant], 'operator'),
    ).toHaveLength(3);
    expect(
      visibleWorldHistoryEntriesV1([member, creator, operator, participant], 'participant'),
    ).toEqual([member, participant]);
    expect(
      visibleWorldHistoryEntriesV1([member, creator, operator, participant], 'public'),
    ).toEqual([]);
  });

  it('keeps participant economy summaries free of amount, price, wallet and memo fields', async () => {
    const source = await import('node:fs/promises').then(({ readFile }) =>
      readFile(new URL('history.ts', import.meta.url), 'utf8'),
    );
    const transferCase = source.slice(
      source.indexOf("case 'CurrencyTransferredV1'"),
      source.indexOf("case 'CurrencyFrozenV1'"),
    );
    expect(transferCase).not.toMatch(/amountMinor|sourceWalletId|destinationWalletId|memo/u);
    const purchaseCase = source.slice(
      source.indexOf("case 'AssetPurchasedV1'"),
      source.indexOf('\n  }\n}', source.indexOf("case 'AssetPurchasedV1'")),
    );
    expect(purchaseCase).not.toMatch(/priceMinor|buyerEntityLogicalKey|sellerEntityLogicalKey/u);
  });

  it('rejects mismatched ledger/event links rather than fabricating history', () => {
    const fixture = createFixtureLedger();
    expect(() => projectWorldHistoryEntryV1(fixture.events[1]!, fixture.entries[0]!)).toThrow(
      'History ledger/event link mismatch',
    );
  });
});
