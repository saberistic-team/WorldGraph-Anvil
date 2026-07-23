'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';

import { BrowserApiError, formString, requestJson } from '../../../lib/browser-api';
import {
  formatMinor,
  humanizeEconomyValue,
  isTickInFuture,
  previewAmount,
  type AssetPage,
  type AssetView,
  type ControlledWalletPage,
  type ControlledWalletView,
  type CurrencyPage,
  type CurrencyView,
  type EconomySummary,
  type OfferPage,
  type OfferView,
} from '../economy-model';
import {
  CommandFeedback,
  CopyableId,
  EconomyStateNotices,
  VirtualValueDisclosure,
  WorldEconomyNav,
  useEconomyCommand,
} from '../economy-ui';

interface WorldAssetsProps {
  worldId: string;
}

function failureMessage(cause: unknown): string {
  return cause instanceof BrowserApiError
    ? `${cause.failure.code}: ${cause.failure.message}`
    : 'ASSETS_UNAVAILABLE: Authoritative assets and offers could not be loaded.';
}

function assetLabel(view: AssetView): string {
  return `${view.asset.metadata.displayName} · ${view.asset.stableKey}`;
}

function walletLabel(wallet: ControlledWalletView): string {
  return `${wallet.currencyCode} · ${humanizeEconomyValue(wallet.wallet.walletKind)} · ${wallet.wallet.ownerEntityLogicalKey}`;
}

export function WorldAssets({ worldId }: WorldAssetsProps) {
  const router = useRouter();
  const errorRef = useRef<HTMLDivElement>(null);
  const acceptPanelRef = useRef<HTMLHeadingElement>(null);
  const ownedOnlyRef = useRef(false);
  const [summary, setSummary] = useState<EconomySummary | null>(null);
  const [assets, setAssets] = useState<AssetPage>({ items: [], nextCursor: null });
  const [offers, setOffers] = useState<OfferPage>({ items: [], nextCursor: null });
  const [currencies, setCurrencies] = useState<CurrencyView[]>([]);
  const [wallets, setWallets] = useState<ControlledWalletView[]>([]);
  const [ownedOnly, setOwnedOnly] = useState(false);
  const [loading, setLoading] = useState(true);
  const [assetLoading, setAssetLoading] = useState(false);
  const [offerLoading, setOfferLoading] = useState(false);
  const [error, setError] = useState('');
  const [giftAssetKey, setGiftAssetKey] = useState('');
  const [offerAssetKey, setOfferAssetKey] = useState('');
  const [sellerWalletId, setSellerWalletId] = useState('');
  const [offerPrice, setOfferPrice] = useState('');
  const [offerExpiry, setOfferExpiry] = useState('');
  const [offerLookupId, setOfferLookupId] = useState('');
  const [offerLookupLoading, setOfferLookupLoading] = useState(false);
  const [offerLookupMessage, setOfferLookupMessage] = useState('');
  const [acceptOfferId, setAcceptOfferId] = useState('');
  const [reviewAsset, setReviewAsset] = useState<AssetView | null>(null);
  const [buyerWalletId, setBuyerWalletId] = useState('');
  const [atomicConfirmed, setAtomicConfirmed] = useState(false);

  const loadAssets = useCallback(
    async (nextOwnedOnly: boolean, cursor?: string) => {
      setAssetLoading(true);
      const query = new URLSearchParams({ limit: '50' });
      if (nextOwnedOnly) query.set('owned', 'true');
      if (cursor) query.set('cursor', cursor);
      try {
        const page = await requestJson<AssetPage>(
          `/api/v1/worlds/${worldId}/assets?${query.toString()}`,
        );
        setAssets((current) => ({
          items: cursor ? [...current.items, ...page.items] : page.items,
          nextCursor: page.nextCursor,
        }));
      } catch (cause) {
        setError(failureMessage(cause));
      } finally {
        setAssetLoading(false);
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
        setAssets({ items: [], nextCursor: null });
        setOffers({ items: [], nextCursor: null });
        setCurrencies([]);
        setWallets([]);
        return;
      }
      const assetQuery = new URLSearchParams({ limit: '50' });
      if (ownedOnlyRef.current) assetQuery.set('owned', 'true');
      const [assetPage, offerPage, currencyPage, walletPage] = await Promise.all([
        requestJson<AssetPage>(`/api/v1/worlds/${worldId}/assets?${assetQuery.toString()}`),
        requestJson<OfferPage>(`/api/v1/worlds/${worldId}/asset-transfer-offers?limit=50`),
        requestJson<CurrencyPage>(`/api/v1/worlds/${worldId}/economy/currencies?limit=100`),
        requestJson<ControlledWalletPage>(`/api/v1/worlds/${worldId}/economy/wallets?limit=100`),
      ]);
      setAssets(assetPage);
      setOffers(offerPage);
      setCurrencies(currencyPage.items);
      setWallets(walletPage.items);
      const controlledAssets = assetPage.items.filter((view) => view.controlledByActor);
      setGiftAssetKey((current) =>
        controlledAssets.some((view) => view.asset.stableKey === current)
          ? current
          : (controlledAssets.at(0)?.asset.stableKey ?? ''),
      );
      setOfferAssetKey((current) =>
        controlledAssets.some((view) => view.asset.stableKey === current)
          ? current
          : (controlledAssets.at(0)?.asset.stableKey ?? ''),
      );
      setSellerWalletId((current) =>
        walletPage.items.some((wallet) => wallet.wallet.id === current)
          ? current
          : (walletPage.items.at(0)?.wallet.id ?? ''),
      );
    } catch (cause) {
      if (cause instanceof BrowserApiError && cause.status === 401) {
        router.replace(`/sign-in?returnTo=${encodeURIComponent(`/worlds/${worldId}/assets`)}`);
        return;
      }
      setError(failureMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [router, worldId]);

  const loadMoreOffers = useCallback(async () => {
    if (!offers.nextCursor) return;
    setOfferLoading(true);
    try {
      const page = await requestJson<OfferPage>(
        `/api/v1/worlds/${worldId}/asset-transfer-offers?limit=50&cursor=${encodeURIComponent(offers.nextCursor)}`,
      );
      setOffers((current) => ({
        items: [...current.items, ...page.items],
        nextCursor: page.nextCursor,
      }));
    } catch (cause) {
      setError(failureMessage(cause));
    } finally {
      setOfferLoading(false);
    }
  }, [offers.nextCursor, worldId]);

  async function lookupDirectOffer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const exactOfferId = offerLookupId.trim();
    setOfferLookupMessage('');
    setOfferLookupLoading(true);
    try {
      const page = await requestJson<OfferPage>(
        `/api/v1/worlds/${worldId}/asset-transfer-offers?limit=1&offerId=${encodeURIComponent(exactOfferId)}`,
      );
      const match = page.items.at(0);
      if (!match) {
        setOfferLookupMessage(
          'No open invitation is available for that exact ID under your participant access.',
        );
        return;
      }
      setOffers((current) => ({
        ...current,
        items: [match, ...current.items.filter((item) => item.offer.id !== match.offer.id)],
      }));
      setOfferLookupMessage(
        match.canAccept
          ? 'The exact open invitation is ready for review.'
          : 'The offer is visible, but the server reports no eligible buyer wallet for this actor.',
      );
      if (match.canAccept) await chooseOffer(match);
    } catch (cause) {
      setOfferLookupMessage(failureMessage(cause));
    } finally {
      setOfferLookupLoading(false);
    }
  }

  useEffect(() => void load(), [load]);
  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  const command = useEconomyCommand({
    onAccepted: load,
    returnPath: `/worlds/${worldId}/assets`,
    summary,
    worldId,
  });

  const controlledAssets = assets.items.filter((view) => view.controlledByActor);
  const giftAsset = assets.items.find((view) => view.asset.stableKey === giftAssetKey);
  const offerAsset = assets.items.find((view) => view.asset.stableKey === offerAssetKey);
  const sellerWallet = wallets.find((wallet) => wallet.wallet.id === sellerWalletId);
  const offerCurrency = currencies.find(
    (item) => item.currency.id === sellerWallet?.wallet.currencyId,
  );
  const pricePreview = useMemo(
    () => previewAmount(offerPrice, offerCurrency?.currency.minorUnitScale ?? 0),
    [offerCurrency?.currency.minorUnitScale, offerPrice],
  );
  const expiryIsFuture = summary ? isTickInFuture(offerExpiry, summary.currentTick) : false;

  const acceptedOffer = offers.items.find((view) => view.offer.id === acceptOfferId);
  const acceptedAsset =
    assets.items.find((view) => view.asset.id === acceptedOffer?.offer.assetId) ??
    (reviewAsset?.asset.id === acceptedOffer?.offer.assetId ? reviewAsset : undefined);
  const acceptedCurrency = currencies.find(
    (item) => item.currency.id === acceptedOffer?.offer.currencyId,
  );
  const eligibleBuyerWallets = wallets.filter(
    (wallet) =>
      wallet.wallet.currencyId === acceptedOffer?.offer.currencyId &&
      wallet.wallet.status === 'active' &&
      wallet.wallet.ownerEntityLogicalKey !== acceptedOffer?.offer.sellerEntityLogicalKey &&
      (acceptedOffer?.offer.buyerEntityLogicalKey === null ||
        wallet.wallet.ownerEntityLogicalKey === acceptedOffer?.offer.buyerEntityLogicalKey),
  );
  const buyerWallet = eligibleBuyerWallets.find((wallet) => wallet.wallet.id === buyerWalletId);
  const buyerWalletVersion =
    buyerWallet?.balance.rowVersion ??
    (acceptedOffer?.eligibleBuyerWallet?.walletId === buyerWalletId
      ? acceptedOffer.eligibleBuyerWallet.walletVersion
      : null);
  const acceptIsOpen = Boolean(
    acceptedOffer &&
    acceptedOffer.offer.status === 'open' &&
    summary &&
    isTickInFuture(acceptedOffer.offer.expiresAtTick, summary.currentTick),
  );
  const actionsBlocked = Boolean(
    !summary ||
    summary.status !== 'ready' ||
    summary.featurePolicy.debitsFrozen ||
    summary.reconciliation.status === 'mismatched',
  );

  function gift(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!giftAsset) {
      command.reportClientError('Choose an asset you currently control.');
      return;
    }
    const recipient = formString(new FormData(event.currentTarget), 'recipient').trim();
    if (!recipient) {
      command.reportClientError('Enter the recipient entity key.');
      return;
    }
    void command.submit('TransferAssetV1', {
      assetKey: giftAsset.asset.stableKey,
      expectedOwnershipVersion: giftAsset.ownership.ownershipVersion,
      toOwnerEntityKey: recipient,
    });
  }

  function createOffer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!offerAsset || !sellerWallet || !offerCurrency || !pricePreview.ok) {
      command.reportClientError(
        pricePreview.ok ? 'Choose a controlled asset and seller wallet.' : pricePreview.message,
      );
      return;
    }
    if (!expiryIsFuture) {
      command.reportClientError(
        `Expiry must be an integer tick later than the current authoritative tick ${summary?.currentTick ?? 'unknown'}.`,
      );
      return;
    }
    const buyerEntityKey = formString(new FormData(event.currentTarget), 'buyerEntityKey').trim();
    void command.submit('CreateAssetTransferOfferV1', {
      assetKey: offerAsset.asset.stableKey,
      buyerEntityKey: buyerEntityKey || null,
      currencyId: offerCurrency.currency.id,
      expectedOwnershipVersion: offerAsset.ownership.ownershipVersion,
      expiresAtTick: offerExpiry,
      price: pricePreview.value.canonical,
      sellerWalletId: sellerWallet.wallet.id,
    });
  }

  function acceptOffer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!acceptedOffer || !acceptedAsset || !buyerWalletId || !buyerWalletVersion) {
      command.reportClientError('Choose an open offer and a controlled buyer wallet.');
      return;
    }
    if (!acceptedOffer.sellerWalletVersion) {
      command.reportClientError(
        'The server did not expose the authorized seller-wallet concurrency token. Refresh before accepting.',
      );
      return;
    }
    if (!acceptedOffer.canAccept || !acceptIsOpen) {
      command.reportClientError('The offer is no longer open at the current authoritative tick.');
      return;
    }
    if (!atomicConfirmed) {
      command.reportClientError('Confirm the atomic payment-and-title boundary before accepting.');
      return;
    }
    void command.submit('AcceptAssetTransferOfferV1', {
      buyerWalletId,
      expectedBuyerWalletVersion: buyerWalletVersion,
      expectedOfferVersion: acceptedOffer.offer.rowVersion,
      expectedOwnershipVersion: acceptedAsset.ownership.ownershipVersion,
      expectedSellerWalletVersion: acceptedOffer.sellerWalletVersion,
      offerId: acceptedOffer.offer.id,
      sellerWalletId: acceptedOffer.offer.sellerWalletId,
    });
  }

  async function chooseOffer(view: OfferView) {
    setAcceptOfferId(view.offer.id);
    const visibleAsset = assets.items.find((item) => item.asset.id === view.offer.assetId);
    if (visibleAsset) {
      setReviewAsset(visibleAsset);
    } else {
      try {
        const asset = await requestJson<AssetView>(
          `/api/v1/worlds/${worldId}/assets/${encodeURIComponent(view.assetKey)}`,
        );
        setReviewAsset(asset);
      } catch (cause) {
        setError(failureMessage(cause));
      }
    }
    const firstWallet = wallets.find(
      (wallet) =>
        wallet.wallet.id === view.eligibleBuyerWallet?.walletId ||
        (wallet.wallet.currencyId === view.offer.currencyId &&
          wallet.wallet.status === 'active' &&
          wallet.wallet.ownerEntityLogicalKey !== view.offer.sellerEntityLogicalKey &&
          (view.offer.buyerEntityLogicalKey === null ||
            wallet.wallet.ownerEntityLogicalKey === view.offer.buyerEntityLogicalKey)),
    );
    setBuyerWalletId(firstWallet?.wallet.id ?? view.eligibleBuyerWallet?.walletId ?? '');
    setAtomicConfirmed(false);
    requestAnimationFrame(() => acceptPanelRef.current?.focus());
  }

  if (loading && !summary) {
    return (
      <main className="app-page shell wide-shell economy-page" id="main-content">
        <section
          aria-busy="true"
          aria-label="Loading authoritative assets"
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
          <strong>Assets could not be loaded</strong>
          <p>{error}</p>
          <button className="button secondary" onClick={() => void load()} type="button">
            Retry authoritative read
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="app-page shell wide-shell economy-page assets-page" id="main-content">
      <header className="app-header runtime-header">
        <Link className="brand-link" href={`/worlds/${worldId}`}>
          ← World workspace
        </Link>
        <WorldEconomyNav current="assets" worldId={worldId} />
      </header>

      <section className="page-heading economy-heading">
        <div>
          <p className="eyebrow">Authoritative world title</p>
          <h1>Assets</h1>
          <p className="lede compact">
            Current ownership, free gifts, and direct transfer offers backed by one immutable title
            event stream.
          </p>
        </div>
        <span className={`manifest-state ${summary.status === 'ready' ? 'approved' : 'draft'}`}>
          Tick {summary.currentTick} · {humanizeEconomyValue(summary.status)}
        </span>
      </section>

      <VirtualValueDisclosure />
      <EconomyStateNotices summary={summary} />
      {error ? (
        <div className="error-summary" ref={errorRef} role="alert" tabIndex={-1}>
          <strong>Some title data may be stale</strong>
          <p>{error}</p>
          <button className="button secondary" onClick={() => void load()} type="button">
            Refresh authoritative state
          </button>
        </div>
      ) : null}
      <CommandFeedback check={command.check} retry={command.retry} state={command.state} />

      {summary.status === 'not_initialized' ? (
        <section className="empty-state economy-not-initialized" aria-labelledby="assets-not-ready">
          <p className="eyebrow">Not initialized</p>
          <h2 id="assets-not-ready">No authoritative asset registry exists yet</h2>
          <p>
            Asset identities and initial owners are materialized only from the deterministic economy
            seed plan. Missing plans never receive invented assets or owners.
          </p>
          <Link className="button secondary" href={`/worlds/${worldId}/economy`}>
            Review economy initialization status
          </Link>
        </section>
      ) : (
        <>
          <section className="card economy-table-card" aria-labelledby="assets-heading">
            <div className="economy-section-heading">
              <div>
                <p className="eyebrow">Single current-owner projection</p>
                <h2 id="assets-heading">World assets</h2>
              </div>
              <label className="checkbox-row economy-owned-filter">
                <input
                  checked={ownedOnly}
                  onChange={(event) => {
                    const next = event.currentTarget.checked;
                    ownedOnlyRef.current = next;
                    setOwnedOnly(next);
                    void loadAssets(next);
                  }}
                  type="checkbox"
                />
                Only assets I control
              </label>
            </div>
            {assetLoading && assets.items.length === 0 ? (
              <p aria-live="polite">Loading authoritative title…</p>
            ) : assets.items.length === 0 ? (
              <div className="empty-state compact-empty">
                <p>
                  {ownedOnly ? 'You do not control a visible asset.' : 'No assets are visible.'}
                </p>
              </div>
            ) : (
              <div className="table-scroll" tabIndex={0}>
                <table className="economy-table asset-table">
                  <caption>Visible asset identity and current authoritative owner</caption>
                  <thead>
                    <tr>
                      <th scope="col">Asset</th>
                      <th scope="col">Type and provenance</th>
                      <th scope="col">Current owner</th>
                      <th scope="col">Transfer state</th>
                      <th scope="col">Asset ID</th>
                    </tr>
                  </thead>
                  <tbody>
                    {assets.items.map((view) => (
                      <tr key={view.asset.id}>
                        <th scope="row">
                          {view.asset.metadata.displayName}
                          <small>{view.asset.stableKey}</small>
                        </th>
                        <td>
                          {humanizeEconomyValue(view.asset.assetType)}
                          <small>Provenance: {view.asset.metadata.provenance}</small>
                        </td>
                        <td>
                          {view.ownership.ownerEntityLogicalKey}
                          <small>
                            Ownership version {view.ownership.ownershipVersion}
                            {view.controlledByActor ? ' · You control this owner' : ''}
                          </small>
                        </td>
                        <td>
                          <span
                            className={`economy-status-chip ${
                              view.asset.status !== 'active' || !view.asset.transferable
                                ? 'frozen'
                                : 'active'
                            }`}
                          >
                            {view.asset.status !== 'active'
                              ? humanizeEconomyValue(view.asset.status)
                              : view.asset.transferable
                                ? 'Transferable'
                                : 'Not transferable'}
                          </span>
                        </td>
                        <td>
                          <CopyableId id={view.asset.id} label="asset ID" />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {assets.nextCursor ? (
              <button
                className="button secondary"
                disabled={assetLoading}
                onClick={() => void loadAssets(ownedOnly, assets.nextCursor ?? undefined)}
                type="button"
              >
                Load more assets
              </button>
            ) : null}
          </section>

          <section className="economy-action-grid" aria-label="Asset owner actions">
            <article className="card">
              <p className="eyebrow">Free owner transfer</p>
              <h2>Gift an asset</h2>
              <form className="form-stack" onSubmit={gift}>
                <label>
                  Asset you control
                  <select
                    disabled={command.pending}
                    onChange={(event) => setGiftAssetKey(event.currentTarget.value)}
                    required
                    value={giftAssetKey}
                  >
                    <option value="">Choose an asset</option>
                    {controlledAssets.map((view) => (
                      <option key={view.asset.id} value={view.asset.stableKey}>
                        {assetLabel(view)}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Recipient entity key
                  <input
                    autoComplete="off"
                    name="recipient"
                    pattern="[a-z0-9][a-z0-9._-]*(?::[a-z0-9][a-z0-9._-]*)+"
                    placeholder="character:recipient-key"
                    required
                  />
                </label>
                <div className="amount-preview">
                  <strong>{giftAsset?.asset.metadata.displayName ?? 'Choose an asset'}</strong>
                  <span>
                    Current owner: {giftAsset?.ownership.ownerEntityLogicalKey ?? '—'} · title
                    version {giftAsset?.ownership.ownershipVersion ?? '—'}
                  </span>
                  <span>No currency posting or fee is created for a gift.</span>
                </div>
                <p className="field-help">
                  The server rechecks that you still control the current owner and then appends one
                  title transfer. The browser never changes owner state directly.
                </p>
                <button
                  className="button"
                  disabled={
                    command.pending ||
                    actionsBlocked ||
                    !giftAsset ||
                    !giftAsset.controlledByActor ||
                    !giftAsset.asset.transferable ||
                    giftAsset.asset.status !== 'active'
                  }
                  type="submit"
                >
                  Gift asset
                </button>
              </form>
            </article>

            <article className="card">
              <p className="eyebrow">Seller-authorized intent</p>
              <h2>Create a direct offer</h2>
              <form className="form-stack" onSubmit={createOffer}>
                <label>
                  Asset you control
                  <select
                    onChange={(event) => setOfferAssetKey(event.currentTarget.value)}
                    required
                    value={offerAssetKey}
                  >
                    <option value="">Choose an asset</option>
                    {controlledAssets.map((view) => (
                      <option key={view.asset.id} value={view.asset.stableKey}>
                        {assetLabel(view)}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Seller wallet
                  <select
                    onChange={(event) => setSellerWalletId(event.currentTarget.value)}
                    required
                    value={sellerWalletId}
                  >
                    <option value="">Choose a controlled wallet</option>
                    {wallets.map((wallet) => (
                      <option key={wallet.wallet.id} value={wallet.wallet.id}>
                        {walletLabel(wallet)}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Buyer entity key (optional direct target)
                  <input
                    autoComplete="off"
                    name="buyerEntityKey"
                    pattern="[a-z0-9][a-z0-9._-]*(?::[a-z0-9][a-z0-9._-]*)+"
                    placeholder="character:buyer-key"
                  />
                </label>
                <div className="economy-two-fields">
                  <label>
                    Exact price in {offerCurrency?.currency.code ?? 'selected currency'}
                    <input
                      inputMode="decimal"
                      onChange={(event) => setOfferPrice(event.currentTarget.value)}
                      placeholder={offerCurrency?.currency.minorUnitScale === 0 ? '10' : '10.00'}
                      required
                      value={offerPrice}
                    />
                  </label>
                  <label>
                    Expires at world tick
                    <input
                      inputMode="numeric"
                      onChange={(event) => setOfferExpiry(event.currentTarget.value)}
                      pattern="(?:0|[1-9][0-9]*)"
                      required
                      value={offerExpiry}
                    />
                  </label>
                </div>
                <div aria-live="polite" className="amount-preview">
                  <strong>
                    Current authoritative tick: {summary.currentTick} · expiry:{' '}
                    {offerExpiry || 'not set'}
                  </strong>
                  {offerPrice && pricePreview.ok ? (
                    <span>
                      Exact price: {pricePreview.value.canonical} {offerCurrency?.currency.code} (
                      {pricePreview.value.minor} minor units)
                    </span>
                  ) : offerPrice ? (
                    <span className="danger-text">
                      {'message' in pricePreview ? pricePreview.message : null}
                    </span>
                  ) : (
                    <span>Enter a price to preview its canonical encoding.</span>
                  )}
                  {offerExpiry && !expiryIsFuture ? (
                    <span className="danger-text">Expiry must be later than the current tick.</span>
                  ) : null}
                </div>
                <button
                  className="button"
                  disabled={
                    command.pending ||
                    actionsBlocked ||
                    !summary.featurePolicy.offersEnabled ||
                    !offerAsset ||
                    !offerAsset.asset.transferable ||
                    offerAsset.asset.status !== 'active' ||
                    !sellerWallet ||
                    sellerWallet.wallet.status !== 'active' ||
                    offerCurrency?.currency.status !== 'active' ||
                    !pricePreview.ok ||
                    !expiryIsFuture
                  }
                  type="submit"
                >
                  Create direct offer
                </button>
              </form>
            </article>
          </section>

          <section className="card" aria-labelledby="offer-invitation-heading">
            <p className="eyebrow">Private invitation</p>
            <h2 id="offer-invitation-heading">Open an offer by exact ID</h2>
            <p>
              An untargeted offer is never listed as a marketplace. Ask the seller for its exact ID,
              then open only that invitation.
            </p>
            <form className="form-stack" onSubmit={(event) => void lookupDirectOffer(event)}>
              <label>
                Exact offer ID
                <input
                  autoComplete="off"
                  disabled={offerLookupLoading}
                  onChange={(event) => setOfferLookupId(event.currentTarget.value.trim())}
                  pattern="[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}"
                  required
                  type="text"
                  value={offerLookupId}
                />
              </label>
              <button className="button secondary" disabled={offerLookupLoading} type="submit">
                {offerLookupLoading ? 'Opening invitation…' : 'Open exact invitation'}
              </button>
              <p aria-live="polite" className="field-help">
                {offerLookupMessage}
              </p>
            </form>
          </section>

          <section className="card economy-table-card" aria-labelledby="offers-heading">
            <div className="economy-section-heading">
              <div>
                <p className="eyebrow">No order book</p>
                <h2 id="offers-heading">Visible direct offers</h2>
              </div>
              <span>{offers.items.length} visible</span>
            </div>
            {offers.items.length === 0 ? (
              <div className="empty-state compact-empty">
                <p>No direct offers are visible under your participant policy.</p>
              </div>
            ) : (
              <div className="table-scroll" tabIndex={0}>
                <table className="economy-table offer-table">
                  <caption>Direct transfer offers visible to this participant</caption>
                  <thead>
                    <tr>
                      <th scope="col">Asset</th>
                      <th scope="col">Seller / buyer</th>
                      <th scope="col">Exact price</th>
                      <th scope="col">Expiry / status</th>
                      <th scope="col">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {offers.items.map((view) => {
                      const currency = currencies.find(
                        (item) => item.currency.id === view.offer.currencyId,
                      );
                      const openNow =
                        view.offer.status === 'open' &&
                        isTickInFuture(view.offer.expiresAtTick, summary.currentTick);
                      return (
                        <tr key={view.offer.id}>
                          <th scope="row">
                            {view.assetKey}
                            <small>
                              <CopyableId id={view.offer.id} label="offer ID" />
                            </small>
                          </th>
                          <td>
                            Seller: {view.offer.sellerEntityLogicalKey}
                            <small>
                              Buyer:{' '}
                              {view.offer.buyerEntityLogicalKey ?? 'any eligible participant'}
                            </small>
                          </td>
                          <td>
                            {currency
                              ? `${formatMinor(view.offer.priceMinor, currency.currency.minorUnitScale)} ${currency.currency.code}`
                              : `${view.offer.priceMinor} minor units`}
                          </td>
                          <td>
                            Tick {view.offer.expiresAtTick}
                            <small>
                              <span
                                className={`economy-status-chip ${openNow ? 'active' : 'frozen'}`}
                              >
                                {view.offer.status === 'open' && !openNow
                                  ? 'Expired by current tick'
                                  : humanizeEconomyValue(view.offer.status)}
                              </span>
                            </small>
                          </td>
                          <td>
                            <span className="economy-inline-actions">
                              {view.canAccept && openNow ? (
                                <button
                                  className="button secondary"
                                  disabled={command.pending || actionsBlocked}
                                  onClick={() => void chooseOffer(view)}
                                  type="button"
                                >
                                  Review purchase
                                </button>
                              ) : null}
                              {view.controlledSeller && view.offer.status === 'open' ? (
                                <button
                                  className="text-button danger-text"
                                  disabled={command.pending}
                                  onClick={() => {
                                    if (window.confirm('Cancel this direct offer?')) {
                                      void command.submit('CancelAssetTransferOfferV1', {
                                        expectedOfferVersion: view.offer.rowVersion,
                                        offerId: view.offer.id,
                                      });
                                    }
                                  }}
                                  type="button"
                                >
                                  Cancel offer
                                </button>
                              ) : null}
                              {!view.canAccept && !view.controlledSeller ? (
                                <span>No available action</span>
                              ) : null}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {offers.nextCursor ? (
              <button
                className="button secondary"
                disabled={offerLoading}
                onClick={() => void loadMoreOffers()}
                type="button"
              >
                Load more offers
              </button>
            ) : null}
          </section>

          {acceptedOffer ? (
            <section
              className="card atomic-purchase-card"
              aria-labelledby="atomic-purchase-heading"
            >
              <p className="eyebrow">One transaction, one revision</p>
              <h2 id="atomic-purchase-heading" ref={acceptPanelRef} tabIndex={-1}>
                Confirm atomic payment and title
              </h2>
              <p>
                Either the exact currency transfer, title transfer, terminal offer event, and ledger
                revision all commit, or none of them do.
              </p>
              <dl className="economy-facts atomic-purchase-facts">
                <div>
                  <dt>Asset</dt>
                  <dd>{acceptedOffer.assetKey}</dd>
                </div>
                <div>
                  <dt>Exact price</dt>
                  <dd>
                    {acceptedCurrency
                      ? `${formatMinor(
                          acceptedOffer.offer.priceMinor,
                          acceptedCurrency.currency.minorUnitScale,
                        )} ${acceptedCurrency.currency.code}`
                      : `${acceptedOffer.offer.priceMinor} minor units`}
                  </dd>
                </div>
                <div>
                  <dt>Expiry / current tick</dt>
                  <dd>
                    {acceptedOffer.offer.expiresAtTick} / {summary.currentTick}
                  </dd>
                </div>
              </dl>
              <form className="form-stack" onSubmit={acceptOffer}>
                <label>
                  Buyer wallet
                  <select
                    onChange={(event) => setBuyerWalletId(event.currentTarget.value)}
                    required
                    value={buyerWalletId}
                  >
                    <option value="">Choose a controlled wallet</option>
                    {eligibleBuyerWallets.map((wallet) => (
                      <option key={wallet.wallet.id} value={wallet.wallet.id}>
                        {walletLabel(wallet)} · available{' '}
                        {formatMinor(wallet.balance.availableMinor, wallet.minorUnitScale)}
                      </option>
                    ))}
                    {acceptedOffer.eligibleBuyerWallet &&
                    !eligibleBuyerWallets.some(
                      (wallet) => wallet.wallet.id === acceptedOffer.eligibleBuyerWallet?.walletId,
                    ) ? (
                      <option value={acceptedOffer.eligibleBuyerWallet.walletId}>
                        {acceptedOffer.eligibleBuyerWallet.ownerEntityLogicalKey} · authorized
                        wallet
                      </option>
                    ) : null}
                  </select>
                </label>
                <label className="checkbox-row atomic-confirmation">
                  <input
                    checked={atomicConfirmed}
                    onChange={(event) => setAtomicConfirmed(event.currentTarget.checked)}
                    type="checkbox"
                  />
                  I understand the server will commit payment and title together or commit neither.
                </label>
                <p className="field-help">
                  Displayed availability is a snapshot, not approval. The server rechecks buyer and
                  seller wallets, exact price, offer, expiry, ownership, and actor control under one
                  deterministic lock set.
                </p>
                {!acceptedOffer.sellerWalletVersion ? (
                  <p className="danger-text" role="status">
                    Seller wallet version is unavailable. Refresh before accepting this offer.
                  </p>
                ) : null}
                <div className="economy-inline-actions">
                  <button
                    className="button"
                    disabled={
                      command.pending ||
                      actionsBlocked ||
                      !summary.featurePolicy.offersEnabled ||
                      !acceptedOffer.canAccept ||
                      !acceptIsOpen ||
                      !acceptedOffer.sellerWalletVersion ||
                      !acceptedAsset ||
                      !buyerWalletId ||
                      !buyerWalletVersion ||
                      !atomicConfirmed
                    }
                    type="submit"
                  >
                    Accept exact price atomically
                  </button>
                  <button
                    className="button secondary"
                    onClick={() => {
                      setAcceptOfferId('');
                      setReviewAsset(null);
                      setAtomicConfirmed(false);
                    }}
                    type="button"
                  >
                    Close review
                  </button>
                </div>
              </form>
            </section>
          ) : null}
        </>
      )}
    </main>
  );
}
