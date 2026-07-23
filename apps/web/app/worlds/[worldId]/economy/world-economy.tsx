'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';

import { BrowserApiError, formString, requestJson } from '../../../lib/browser-api';
import {
  formatMinor,
  humanizeEconomyValue,
  previewAmount,
  projectedMinor,
  type ControlledWalletPage,
  type ControlledWalletView,
  type CurrencyPage,
  type CurrencyView,
  type EconomySummary,
  type WalletTransactionPage,
  type WalletTransactionView,
} from '../economy-model';
import {
  CommandFeedback,
  CopyableId,
  EconomyStateNotices,
  VirtualValueDisclosure,
  WorldEconomyNav,
  useEconomyCommand,
} from '../economy-ui';

interface WorldEconomyProps {
  worldId: string;
}

function loadFailure(cause: unknown): string {
  return cause instanceof BrowserApiError
    ? `${cause.failure.code}: ${cause.failure.message}`
    : 'ECONOMY_UNAVAILABLE: The authoritative economy could not be loaded.';
}

function currencyForWallet(
  wallet: ControlledWalletView | undefined,
  currencies: CurrencyView[],
): CurrencyView | undefined {
  return currencies.find((item) => item.currency.id === wallet?.wallet.currencyId);
}

function walletLabel(wallet: ControlledWalletView): string {
  return `${humanizeEconomyValue(wallet.wallet.walletKind)} · ${wallet.wallet.ownerEntityLogicalKey}`;
}

function displayTime(value: string | null): string {
  if (value === null) return 'Not run';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}

export function WorldEconomy({ worldId }: WorldEconomyProps) {
  const router = useRouter();
  const errorRef = useRef<HTMLDivElement>(null);
  const selectedWalletRef = useRef('');
  const [summary, setSummary] = useState<EconomySummary | null>(null);
  const [activeWorldVersionId, setActiveWorldVersionId] = useState<string | null>(null);
  const [currencies, setCurrencies] = useState<CurrencyView[]>([]);
  const [wallets, setWallets] = useState<ControlledWalletView[]>([]);
  const [transactions, setTransactions] = useState<WalletTransactionPage>({
    items: [],
    nextCursor: null,
  });
  const [selectedWalletId, setSelectedWalletId] = useState('');
  const [loading, setLoading] = useState(true);
  const [transactionLoading, setTransactionLoading] = useState(false);
  const [error, setError] = useState('');
  const [transactionError, setTransactionError] = useState('');
  const [transferAmount, setTransferAmount] = useState('');
  const [destinationWalletId, setDestinationWalletId] = useState('');
  const [destinationWalletVersion, setDestinationWalletVersion] = useState('');
  const [transferConfirmed, setTransferConfirmed] = useState(false);
  const [sourceWalletId, setSourceWalletId] = useState('');
  const [issuanceAmount, setIssuanceAmount] = useState('');
  const [issuanceConfirmation, setIssuanceConfirmation] = useState('');
  const [initializationConfirmed, setInitializationConfirmed] = useState(false);

  const loadTransactions = useCallback(
    async (walletId: string, cursor?: string) => {
      if (!walletId) {
        setTransactions({ items: [], nextCursor: null });
        return;
      }
      setTransactionLoading(true);
      setTransactionError('');
      const query = new URLSearchParams({ limit: '50' });
      if (cursor) query.set('cursor', cursor);
      try {
        const page = await requestJson<WalletTransactionPage>(
          `/api/v1/worlds/${worldId}/economy/wallets/${encodeURIComponent(walletId)}/transactions?${query.toString()}`,
        );
        setTransactions((current) => ({
          items: cursor ? [...current.items, ...page.items] : page.items,
          nextCursor: page.nextCursor,
        }));
      } catch (cause) {
        setTransactionError(loadFailure(cause));
      } finally {
        setTransactionLoading(false);
      }
    },
    [worldId],
  );

  const load = useCallback(async () => {
    setError('');
    try {
      const economySummary = await requestJson<EconomySummary>(
        `/api/v1/worlds/${worldId}/economy/summary`,
      );
      setSummary(economySummary);
      if (economySummary.status === 'not_initialized') {
        setCurrencies([]);
        setWallets([]);
        setTransactions({ items: [], nextCursor: null });
        if (economySummary.capabilities.canInitialize) {
          try {
            const worldResponse = await requestJson<{
              world: { activeWorldVersionId: string | null };
            }>(`/api/v1/worlds/${worldId}`);
            setActiveWorldVersionId(worldResponse.world.activeWorldVersionId);
          } catch {
            setActiveWorldVersionId(null);
          }
        }
        return;
      }
      setActiveWorldVersionId(null);
      const [currencyPage, walletPage] = await Promise.all([
        requestJson<CurrencyPage>(`/api/v1/worlds/${worldId}/economy/currencies?limit=100`),
        requestJson<ControlledWalletPage>(`/api/v1/worlds/${worldId}/economy/wallets?limit=100`),
      ]);
      setCurrencies(currencyPage.items);
      setWallets(walletPage.items);
      const previous = selectedWalletRef.current;
      const nextSelected = walletPage.items.some((item) => item.wallet.id === previous)
        ? previous
        : (walletPage.items.at(0)?.wallet.id ?? '');
      selectedWalletRef.current = nextSelected;
      setSelectedWalletId(nextSelected);
      setSourceWalletId((current) =>
        walletPage.items.some((item) => item.wallet.id === current)
          ? current
          : (walletPage.items.at(0)?.wallet.id ?? ''),
      );
      await loadTransactions(nextSelected);
    } catch (cause) {
      if (cause instanceof BrowserApiError && cause.status === 401) {
        router.replace(`/sign-in?returnTo=${encodeURIComponent(`/worlds/${worldId}/economy`)}`);
        return;
      }
      setError(loadFailure(cause));
    } finally {
      setLoading(false);
    }
  }, [loadTransactions, router, worldId]);

  useEffect(() => void load(), [load]);
  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  const command = useEconomyCommand({
    onAccepted: load,
    returnPath: `/worlds/${worldId}/economy`,
    summary,
    worldId,
  });

  const sourceWallet = wallets.find((item) => item.wallet.id === sourceWalletId);
  const sourceCurrency = currencyForWallet(sourceWallet, currencies);
  const transferPreview = useMemo(
    () => previewAmount(transferAmount, sourceWallet?.minorUnitScale ?? 0),
    [sourceWallet?.minorUnitScale, transferAmount],
  );
  const remainingMinor =
    transferPreview.ok && sourceWallet
      ? projectedMinor(sourceWallet.balance.availableMinor, `-${transferPreview.value.minor}`)
      : null;

  const issuanceTarget = summary?.issuanceTarget ?? null;
  const issuancePreview = useMemo(
    () => previewAmount(issuanceAmount, issuanceTarget?.minorUnitScale ?? 0),
    [issuanceAmount, issuanceTarget?.minorUnitScale],
  );
  const newSupplyMinor =
    issuancePreview.ok && issuanceTarget
      ? projectedMinor(issuanceTarget.currentSupplyMinor, issuancePreview.value.minor)
      : null;
  const exceedsCap = Boolean(
    newSupplyMinor &&
    issuanceTarget?.maxSupplyMinor &&
    BigInt(newSupplyMinor) > BigInt(issuanceTarget.maxSupplyMinor),
  );

  const actionsBlocked =
    !summary ||
    summary.status !== 'ready' ||
    summary.featurePolicy.debitsFrozen ||
    summary.reconciliation.status === 'mismatched';

  function transfer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!sourceWallet || !transferPreview.ok) {
      command.reportClientError(
        transferPreview.ok ? 'Choose a controlled source wallet.' : transferPreview.message,
      );
      return;
    }
    if (remainingMinor === null) {
      command.reportClientError(
        'This snapshot does not show enough available virtual currency. The server always makes the final decision.',
      );
      return;
    }
    const data = new FormData(event.currentTarget);
    const memo = formString(data, 'memo').trim();
    if (!destinationWalletId || !/^[1-9][0-9]*$/u.test(destinationWalletVersion)) {
      command.reportClientError('Enter the recipient wallet ID and its current positive version.');
      return;
    }
    if (!transferConfirmed) {
      command.reportClientError('Confirm the exact recipient and amount before transferring.');
      return;
    }
    void command.submit('TransferCurrencyV1', {
      amount: transferPreview.value.canonical,
      destinationWalletId,
      expectedDestinationVersion: destinationWalletVersion,
      expectedSourceVersion: sourceWallet.balance.rowVersion,
      ...(memo ? { memo } : {}),
      sourceWalletId: sourceWallet.wallet.id,
    });
  }

  function issue(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!issuanceTarget || !issuancePreview.ok) {
      command.reportClientError(
        issuancePreview.ok
          ? 'The server did not expose an authorized treasury issuance target.'
          : issuancePreview.message,
      );
      return;
    }
    if (exceedsCap || newSupplyMinor === null) {
      command.reportClientError('This issuance preview exceeds the immutable supply boundary.');
      return;
    }
    const data = new FormData(event.currentTarget);
    const reason = formString(data, 'reason').trim();
    if (reason.length < 8) {
      command.reportClientError('Give an audit reason of at least 8 characters.');
      return;
    }
    if (issuanceConfirmation !== 'ISSUE VIRTUAL CURRENCY') {
      command.reportClientError(
        'Type the exact confirmation phrase before issuing virtual currency.',
      );
      return;
    }
    void command.submit('IssueCurrencyV1', {
      amount: issuancePreview.value.canonical,
      confirmation: 'ISSUE VIRTUAL CURRENCY',
      expectedSupplyVersion: issuanceTarget.supplyVersion,
      reason,
      treasuryWalletId: issuanceTarget.treasuryWalletId,
    });
  }

  if (loading && !summary) {
    return (
      <main className="app-page shell wide-shell economy-page" id="main-content">
        <section
          aria-busy="true"
          aria-label="Loading authoritative economy"
          className="runtime-loading"
        >
          <div className="card skeleton-card" />
          <div className="card skeleton-card" />
          <div className="card skeleton-card" />
        </section>
      </main>
    );
  }

  if (!summary) {
    return (
      <main className="app-page shell wide-shell economy-page" id="main-content">
        <header className="app-header">
          <Link className="brand-link" href={`/worlds/${worldId}`}>
            ← World workspace
          </Link>
        </header>
        <div className="error-summary" ref={errorRef} role="alert" tabIndex={-1}>
          <strong>Economy could not be loaded</strong>
          <p>{error}</p>
          <button className="button secondary" onClick={() => void load()} type="button">
            Retry authoritative read
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="app-page shell wide-shell economy-page" id="main-content">
      <header className="app-header runtime-header">
        <Link className="brand-link" href={`/worlds/${worldId}`}>
          ← World workspace
        </Link>
        <WorldEconomyNav current="economy" worldId={worldId} />
      </header>

      <section className="page-heading economy-heading">
        <div>
          <p className="eyebrow">Closed-loop world economy</p>
          <h1>Economy</h1>
          <p className="lede compact">
            Controlled wallets, exact balances, immutable postings, and reconciliation from the
            authoritative world ledger.
          </p>
        </div>
        <span className={`manifest-state ${summary.status === 'ready' ? 'approved' : 'draft'}`}>
          {humanizeEconomyValue(summary.status)} · tick {summary.currentTick}
        </span>
      </section>

      <VirtualValueDisclosure />
      {error ? (
        <div className="error-summary" ref={errorRef} role="alert" tabIndex={-1}>
          <strong>Some economy data may be stale</strong>
          <p>{error}</p>
          <button className="button secondary" onClick={() => void load()} type="button">
            Refresh authoritative state
          </button>
        </div>
      ) : null}
      <EconomyStateNotices summary={summary} />
      <CommandFeedback check={command.check} retry={command.retry} state={command.state} />

      {summary.status === 'not_initialized' ? (
        <section
          className="empty-state economy-not-initialized"
          aria-labelledby="economy-not-ready"
        >
          <p className="eyebrow">Not initialized</p>
          <h2 id="economy-not-ready">No authoritative economy exists yet</h2>
          <p>
            {summary.seedPlan.available
              ? 'A deterministic compiled seed plan is available, but its one-time audited initializer has not run.'
              : 'This active world has no compatible economy seed plan. No currency, balance, or owner will be invented.'}
          </p>
          <p>
            Capability:{' '}
            <strong>
              {summary.capabilities.canInitialize
                ? 'creator initialization available'
                : summary.capabilities.canAdoptLegacySeed
                  ? 'audited legacy-plan adoption available'
                  : 'initialization unavailable'}
            </strong>
          </p>
          {summary.capabilities.canInitialize && summary.seedPlan.hash && activeWorldVersionId ? (
            <div className="economy-initializer">
              <label className="checkbox-row atomic-confirmation">
                <input
                  checked={initializationConfirmed}
                  onChange={(event) => setInitializationConfirmed(event.currentTarget.checked)}
                  type="checkbox"
                />
                Initialize exactly from this compiled seed plan. Do not invent or edit currency,
                balances, assets, or owners.
              </label>
              <CopyableId id={summary.seedPlan.hash} label="economy seed-plan hash" />
              <button
                className="button"
                disabled={command.pending || !initializationConfirmed}
                onClick={() =>
                  void command.submit('InitializeWorldEconomyV1', {
                    compiledWorldVersionId: activeWorldVersionId,
                    seedPlanHash: summary.seedPlan.hash,
                  })
                }
                type="button"
              >
                Initialize deterministic economy
              </button>
            </div>
          ) : null}
          <Link className="button secondary" href={`/worlds/${worldId}/manifest`}>
            Review compiled world provenance
          </Link>
        </section>
      ) : (
        <>
          <section aria-labelledby="economy-summary-heading" className="economy-metric-grid">
            <article className="card economy-status-card">
              <p className="eyebrow">Reconciliation</p>
              <h2 id="economy-summary-heading">
                {humanizeEconomyValue(summary.reconciliation.status)}
              </h2>
              <dl className="economy-facts">
                <div>
                  <dt>Current state revision</dt>
                  <dd>{summary.stateRevision}</dd>
                </div>
                <div>
                  <dt>Last reconciled revision</dt>
                  <dd>{summary.reconciliation.lastReconciledStateRevision ?? 'Not run'}</dd>
                </div>
                <div>
                  <dt>Last reconciled at</dt>
                  <dd>{displayTime(summary.reconciliation.lastReconciledAt)}</dd>
                </div>
                <div>
                  <dt>Projection checksum</dt>
                  <dd>
                    <code>{summary.projectionChecksum ?? 'Pending'}</code>
                  </dd>
                </div>
              </dl>
              {summary.capabilities.canReconcile && summary.economyHeadVersion ? (
                <button
                  className="button secondary"
                  disabled={command.pending}
                  onClick={() =>
                    void command.submit('ReconcileWorldEconomyV1', {
                      expectedEconomyHeadVersion: summary.economyHeadVersion,
                    })
                  }
                  type="button"
                >
                  Run read-only reconciliation
                </button>
              ) : null}
            </article>

            {currencies.map((item) => (
              <article className="card currency-card" key={item.currency.id}>
                <div className="economy-card-heading">
                  <div>
                    <p className="eyebrow">{item.currency.code}</p>
                    <h2>{item.currency.name}</h2>
                  </div>
                  <span className={`economy-status-chip ${item.currency.status}`}>
                    {humanizeEconomyValue(item.currency.status)}
                  </span>
                </div>
                <dl className="economy-facts">
                  <div>
                    <dt>Current supply</dt>
                    <dd>
                      {formatMinor(item.currentSupplyMinor, item.currency.minorUnitScale)}{' '}
                      {item.currency.code}
                    </dd>
                  </div>
                  <div>
                    <dt>Supply cap</dt>
                    <dd>
                      {item.currency.maxSupplyMinor === null
                        ? 'Uncapped'
                        : `${formatMinor(item.currency.maxSupplyMinor, item.currency.minorUnitScale)} ${item.currency.code}`}
                    </dd>
                  </div>
                  <div>
                    <dt>Precision</dt>
                    <dd>{item.currency.minorUnitScale} decimal places</dd>
                  </div>
                </dl>
              </article>
            ))}
          </section>

          {currencies.length === 0 ? (
            <section className="empty-state">
              <h2>No visible currencies</h2>
              <p>The server did not expose any currency under your current visibility policy.</p>
            </section>
          ) : null}

          <section className="card economy-table-card" aria-labelledby="wallets-heading">
            <div className="economy-section-heading">
              <div>
                <p className="eyebrow">Actor-scoped access</p>
                <h2 id="wallets-heading">Controlled wallets</h2>
              </div>
              <span>{wallets.length} visible</span>
            </div>
            {wallets.length === 0 ? (
              <div className="empty-state compact-empty">
                <p>You do not currently control a wallet in this world.</p>
              </div>
            ) : (
              <div className="table-scroll" tabIndex={0}>
                <table className="economy-table">
                  <caption>Wallets whose owners are controlled by the signed-in actor</caption>
                  <thead>
                    <tr>
                      <th scope="col">Owner and kind</th>
                      <th scope="col">Available balance</th>
                      <th scope="col">Status</th>
                      <th scope="col">Wallet ID</th>
                    </tr>
                  </thead>
                  <tbody>
                    {wallets.map((wallet) => (
                      <tr key={wallet.wallet.id}>
                        <th scope="row">
                          {wallet.wallet.ownerEntityLogicalKey}
                          <small>{humanizeEconomyValue(wallet.wallet.walletKind)}</small>
                        </th>
                        <td>
                          {formatMinor(wallet.balance.availableMinor, wallet.minorUnitScale)}{' '}
                          {wallet.currencyCode}
                        </td>
                        <td>
                          <span className={`economy-status-chip ${wallet.wallet.status}`}>
                            {humanizeEconomyValue(wallet.wallet.status)}
                          </span>
                        </td>
                        <td>
                          <CopyableId id={wallet.wallet.id} label="wallet ID" />
                          <small>Balance version {wallet.balance.rowVersion}</small>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="economy-action-grid" aria-label="Economy actions">
            <article className="card">
              <p className="eyebrow">Controlled debit</p>
              <h2>Transfer virtual currency</h2>
              <p>
                Recipient wallet details are exchanged directly between participants. There is no
                public wallet directory.
              </p>
              <form className="form-stack" onSubmit={transfer}>
                <label>
                  Source wallet
                  <select
                    disabled={command.pending}
                    name="sourceWalletId"
                    onChange={(event) => {
                      setSourceWalletId(event.currentTarget.value);
                      setTransferConfirmed(false);
                    }}
                    required
                    value={sourceWalletId}
                  >
                    <option value="">Choose a controlled wallet</option>
                    {wallets.map((wallet) => (
                      <option key={wallet.wallet.id} value={wallet.wallet.id}>
                        {walletLabel(wallet)}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="economy-two-fields">
                  <label>
                    Recipient wallet ID
                    <input
                      autoComplete="off"
                      name="destinationWalletId"
                      onChange={(event) => {
                        setDestinationWalletId(event.currentTarget.value.trim());
                        setTransferConfirmed(false);
                      }}
                      required
                      type="text"
                      value={destinationWalletId}
                    />
                  </label>
                  <label>
                    Recipient wallet version
                    <input
                      inputMode="numeric"
                      name="expectedDestinationVersion"
                      onChange={(event) => {
                        setDestinationWalletVersion(event.currentTarget.value.trim());
                        setTransferConfirmed(false);
                      }}
                      pattern="[1-9][0-9]*"
                      required
                      value={destinationWalletVersion}
                    />
                  </label>
                </div>
                <label>
                  Amount in {sourceWallet?.currencyCode ?? 'selected currency'}
                  <input
                    autoComplete="off"
                    inputMode="decimal"
                    name="amount"
                    onChange={(event) => {
                      setTransferAmount(event.currentTarget.value);
                      setTransferConfirmed(false);
                    }}
                    placeholder={sourceWallet?.minorUnitScale === 0 ? '25' : '25.00'}
                    required
                    value={transferAmount}
                  />
                </label>
                <div aria-live="polite" className="amount-preview">
                  {transferAmount && transferPreview.ok ? (
                    <>
                      <strong>
                        Exact submission: {transferPreview.value.canonical}{' '}
                        {sourceWallet?.currencyCode}
                      </strong>
                      <span>{transferPreview.value.minor} minor units · fee 0</span>
                      <span>Recipient wallet: {destinationWalletId || 'not set'}</span>
                      <span>
                        Source balance preview:{' '}
                        {remainingMinor === null
                          ? 'insufficient in this snapshot'
                          : `${formatMinor(remainingMinor, sourceWallet?.minorUnitScale ?? 0)} ${sourceWallet?.currencyCode}`}
                      </span>
                    </>
                  ) : transferAmount ? (
                    <span className="danger-text">
                      {'message' in transferPreview ? transferPreview.message : null}
                    </span>
                  ) : (
                    <span>Enter an amount to preview its exact canonical encoding.</span>
                  )}
                </div>
                <label>
                  Memo (optional, visible under transaction policy)
                  <input maxLength={160} name="memo" type="text" />
                </label>
                <p className="field-help">
                  The preview uses the last authoritative snapshot only. The server rechecks
                  control, versions, currency, status, and funds in one transaction.
                </p>
                <label className="checkbox-row atomic-confirmation">
                  <input
                    checked={transferConfirmed}
                    onChange={(event) => setTransferConfirmed(event.currentTarget.checked)}
                    type="checkbox"
                  />
                  I checked the recipient wallet and exact virtual-currency amount above.
                </label>
                <button
                  className="button"
                  disabled={
                    command.pending ||
                    actionsBlocked ||
                    !summary.featurePolicy.transfersEnabled ||
                    !sourceWallet ||
                    sourceWallet.wallet.status !== 'active' ||
                    sourceCurrency?.currency.status !== 'active' ||
                    !transferPreview.ok ||
                    remainingMinor === null ||
                    !transferConfirmed
                  }
                  type="submit"
                >
                  Transfer virtual currency
                </button>
              </form>
            </article>

            <article className="card transaction-safety-card">
              <p className="eyebrow">Commit boundary</p>
              <h2>Server-authoritative outcome</h2>
              <ul className="economy-check-list">
                <li>✓ Balances never come from browser arithmetic.</li>
                <li>✓ Both wallet versions are checked under deterministic locks.</li>
                <li>✓ Debit, credit, postings, event, and ledger revision commit together.</li>
                <li>✓ Retrying the same command ID cannot duplicate the transfer.</li>
              </ul>
            </article>
          </section>

          {summary.capabilities.canIssue ? (
            <details className="danger-zone card">
              <summary>Creator override: issue virtual currency</summary>
              <div className="danger-zone-content">
                <p className="eyebrow">Irreversible, capped, and audited</p>
                <h2>Issue to a treasury wallet</h2>
                <p>
                  This is not a deposit and creates no cash value. The command records the creator,
                  reason, supply change, immutable posting, and general-ledger event.
                </p>
                <form className="form-stack" onSubmit={issue}>
                  {issuanceTarget ? (
                    <dl className="economy-facts">
                      <div>
                        <dt>Authorized target</dt>
                        <dd>
                          Treasury wallet{' '}
                          <CopyableId
                            id={issuanceTarget.treasuryWalletId}
                            label="treasury wallet ID"
                          />
                        </dd>
                      </div>
                      <div>
                        <dt>Current treasury balance</dt>
                        <dd>
                          {formatMinor(
                            issuanceTarget.treasuryBalanceMinor,
                            issuanceTarget.minorUnitScale,
                          )}{' '}
                          {issuanceTarget.currencyCode}
                        </dd>
                      </div>
                    </dl>
                  ) : (
                    <p className="danger-text" role="status">
                      No authorized treasury issuance target is available.
                    </p>
                  )}
                  <label>
                    Amount to issue
                    <input
                      inputMode="decimal"
                      onChange={(event) => setIssuanceAmount(event.currentTarget.value)}
                      required
                      value={issuanceAmount}
                    />
                  </label>
                  <div aria-live="polite" className="amount-preview">
                    {issuanceAmount && issuancePreview.ok && issuanceTarget ? (
                      <>
                        <strong>
                          Exact issuance: {issuancePreview.value.canonical}{' '}
                          {issuanceTarget.currencyCode}
                        </strong>
                        <span>
                          Snapshot supply after issuance:{' '}
                          {newSupplyMinor === null
                            ? 'outside supported range'
                            : `${formatMinor(newSupplyMinor, issuanceTarget.minorUnitScale)} ${issuanceTarget.currencyCode}`}
                        </span>
                        <span className={exceedsCap ? 'danger-text' : undefined}>
                          Cap:{' '}
                          {issuanceTarget.maxSupplyMinor === null
                            ? 'uncapped'
                            : `${formatMinor(
                                issuanceTarget.maxSupplyMinor,
                                issuanceTarget.minorUnitScale,
                              )} ${issuanceTarget.currencyCode}`}
                        </span>
                      </>
                    ) : issuanceAmount ? (
                      <span className="danger-text">
                        {'message' in issuancePreview ? issuancePreview.message : null}
                      </span>
                    ) : (
                      <span>Enter an amount to preview its exact supply effect.</span>
                    )}
                  </div>
                  <label>
                    Audit reason
                    <textarea maxLength={240} minLength={8} name="reason" required />
                  </label>
                  <label>
                    Type ISSUE VIRTUAL CURRENCY to confirm
                    <input
                      autoComplete="off"
                      onChange={(event) => setIssuanceConfirmation(event.currentTarget.value)}
                      required
                      value={issuanceConfirmation}
                    />
                  </label>
                  <button
                    className="button danger"
                    disabled={
                      command.pending ||
                      summary.status !== 'ready' ||
                      !summary.featurePolicy.issuanceEnabled ||
                      !issuanceTarget ||
                      !issuancePreview.ok ||
                      newSupplyMinor === null ||
                      exceedsCap ||
                      issuanceConfirmation !== 'ISSUE VIRTUAL CURRENCY'
                    }
                    type="submit"
                  >
                    Issue and record override
                  </button>
                </form>
              </div>
            </details>
          ) : null}

          <section className="card economy-table-card" aria-labelledby="transactions-heading">
            <div className="economy-section-heading">
              <div>
                <p className="eyebrow">Immutable accounting facts</p>
                <h2 id="transactions-heading">Transactions and postings</h2>
              </div>
              <label>
                Wallet
                <select
                  onChange={(event) => {
                    const walletId = event.currentTarget.value;
                    selectedWalletRef.current = walletId;
                    setSelectedWalletId(walletId);
                    void loadTransactions(walletId);
                  }}
                  value={selectedWalletId}
                >
                  {wallets.map((wallet) => (
                    <option key={wallet.wallet.id} value={wallet.wallet.id}>
                      {walletLabel(wallet)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {transactionError ? (
              <div className="error-summary" role="alert">
                <p>{transactionError}</p>
                <button
                  className="button secondary"
                  onClick={() => void loadTransactions(selectedWalletId)}
                  type="button"
                >
                  Retry transaction read
                </button>
              </div>
            ) : null}
            {transactionLoading && transactions.items.length === 0 ? (
              <p aria-live="polite">Loading immutable transactions…</p>
            ) : transactions.items.length === 0 ? (
              <div className="empty-state compact-empty">
                <p>No visible transactions for this wallet.</p>
              </div>
            ) : (
              <div className="table-scroll" tabIndex={0}>
                <table className="economy-table transaction-table">
                  <caption>
                    Immutable financial transactions and their balanced wallet postings
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Kind / tick</th>
                      <th scope="col">Memo</th>
                      <th scope="col">Supply delta</th>
                      <th scope="col">Identifiers</th>
                      <th scope="col">Postings</th>
                    </tr>
                  </thead>
                  <tbody>
                    {transactions.items.map((view) => (
                      <TransactionRow
                        currencies={currencies}
                        key={view.transaction.id}
                        view={view}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {transactions.nextCursor ? (
              <button
                className="button secondary"
                disabled={transactionLoading}
                onClick={() =>
                  void loadTransactions(selectedWalletId, transactions.nextCursor ?? undefined)
                }
                type="button"
              >
                Load older transactions
              </button>
            ) : null}
          </section>
        </>
      )}
    </main>
  );
}

function TransactionRow({
  currencies,
  view,
}: {
  currencies: CurrencyView[];
  view: WalletTransactionView;
}) {
  const currency = currencies.find((item) => item.currency.id === view.transaction.currencyId);
  const scale = currency?.currency.minorUnitScale ?? 0;
  const code = currency?.currency.code ?? 'minor units';
  return (
    <tr>
      <th scope="row">
        {humanizeEconomyValue(view.transaction.kind)}
        <small>
          Tick {view.transaction.occurredTick} · revision {view.transaction.stateRevision}
        </small>
      </th>
      <td>{view.memo ?? '—'}</td>
      <td>
        {formatMinor(view.transaction.supplyDeltaMinor, scale)} {code}
      </td>
      <td>
        <span className="id-label">Transaction</span>
        <CopyableId id={view.transaction.id} label="transaction ID" />
        <span className="id-label">Command</span>
        <CopyableId id={view.transaction.commandId} label="command ID" />
        <small>
          <Link className="text-link" href={`/worlds/${view.transaction.worldId}/history`}>
            Open world History
          </Link>
        </small>
      </td>
      <td>
        <details className="posting-details">
          <summary>{view.transaction.postings.length} immutable postings</summary>
          <table>
            <caption>Postings for transaction {view.transaction.id}</caption>
            <thead>
              <tr>
                <th scope="col">Ordinal</th>
                <th scope="col">Wallet</th>
                <th scope="col">Signed amount</th>
              </tr>
            </thead>
            <tbody>
              {view.transaction.postings.map((posting) => (
                <tr key={`${posting.transactionId}-${posting.postingOrdinal}`}>
                  <td>{posting.postingOrdinal}</td>
                  <td>
                    <CopyableId id={posting.walletId} label="posting wallet ID" />
                  </td>
                  <td>
                    {formatMinor(posting.signedAmountMinor, scale)} {code}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      </td>
    </tr>
  );
}
