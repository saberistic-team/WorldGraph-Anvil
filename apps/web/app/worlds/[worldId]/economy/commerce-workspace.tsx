'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';

import { BrowserApiError, requestJson } from '../../../lib/browser-api';
import {
  formatMinor,
  isTickInFuture,
  previewAmount,
  type AssetPage,
  type AssetView,
  type ControlledWalletPage,
  type ControlledWalletView,
  type EconomySummary,
} from '../economy-model';
import {
  CommandFeedback,
  CopyableId,
  VirtualValueDisclosure,
  WorldEconomyNav,
  useEconomyCommand,
} from '../economy-ui';
import {
  commerceProjectionAllowsActions,
  exactPositiveQuantity,
  formatExactQuantity,
  isTerminalCommerceStatus,
  positiveWholeRunQuantity,
  projectionMessage,
  purchaseConfirmationRows,
  quantityFitsAvailable,
  selectProductionInventories,
  type BusinessView,
  type CommercePage,
  type CommerceProjection,
  type CommerceSection,
  type EmploymentContractView,
  type EmploymentCandidateView,
  type EmploymentOfferView,
  type FacilityView,
  type InventoryView,
  type JobRecordView,
  type MarketListingView,
  type MarketTradeView,
  type ProductionRunView,
  type PurchasePreview,
  type RecipeView,
  type ReconciliationSummary,
  type ResourceTypeView,
  type TaxAssessmentView,
  type TreasuryView,
} from './commerce-model';

interface CommerceWorkspaceProps {
  section: CommerceSection;
  worldId: string;
}

interface CommerceData {
  assets: AssetView[];
  businesses: BusinessView[];
  contracts: EmploymentContractView[];
  facilities: FacilityView[];
  inventories: InventoryView[];
  jobs: JobRecordView[];
  listings: MarketListingView[];
  offers: EmploymentOfferView[];
  recipes: RecipeView[];
  runs: ProductionRunView[];
  taxAssessments: TaxAssessmentView[];
  trades: MarketTradeView[];
  resources: ResourceTypeView[];
}

const emptyData: CommerceData = {
  assets: [],
  businesses: [],
  contracts: [],
  facilities: [],
  inventories: [],
  jobs: [],
  listings: [],
  offers: [],
  recipes: [],
  resources: [],
  runs: [],
  taxAssessments: [],
  trades: [],
};

const MAX_SIGNED_INT64 = 9_223_372_036_854_775_807n;

const sectionCopy: Record<CommerceSection, { eyebrow: string; title: string; text: string }> = {
  business: {
    eyebrow: 'Organizations and work',
    text: 'Businesses, owned facilities, public offers, private participant contracts, and payroll outcomes.',
    title: 'Business & jobs',
  },
  market: {
    eyebrow: 'Atomic fixed-price exchange',
    text: 'Reserved inventory, partial fills, itemized taxes and fees, and immutable trade outcomes.',
    title: 'Marketplace',
  },
  production: {
    eyebrow: 'Scheduled transformation',
    text: 'Recipe snapshots and terminal production outcomes driven by the authoritative world clock.',
    title: 'Production',
  },
  resources: {
    eyebrow: 'Exact-unit material state',
    text: 'Resource definitions, recipes, and inventories with reserved and available quantities.',
    title: 'Resources & inventory',
  },
  treasury: {
    eyebrow: 'Public-world fiscal record',
    text: 'Treasury balance, collected revenue, tax assessments, and expansion reconciliation.',
    title: 'Treasury & reconciliation',
  },
};

function failureMessage(cause: unknown): string {
  return cause instanceof BrowserApiError
    ? `${cause.failure.code}: ${cause.failure.message}`
    : 'COMMERCE_UNAVAILABLE: Authoritative commerce reads are temporarily unavailable.';
}

async function page<T>(worldId: string, path: string): Promise<CommercePage<T>> {
  return requestJson<CommercePage<T>>(`/api/v1/worlds/${worldId}/economy/${path}?limit=50`);
}

export function CommerceWorkspace({ section, worldId }: CommerceWorkspaceProps) {
  const copy = sectionCopy[section];
  const router = useRouter();
  const errorRef = useRef<HTMLDivElement>(null);
  const [data, setData] = useState<CommerceData>(emptyData);
  const [summary, setSummary] = useState<EconomySummary | null>(null);
  const [reconciliation, setReconciliation] = useState<ReconciliationSummary | null>(null);
  const [projection, setProjection] = useState<CommerceProjection | null>(null);
  const [treasury, setTreasury] = useState<TreasuryView | null>(null);
  const [wallets, setWallets] = useState<ControlledWalletView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      const [economySummary, reconciliationSummary] = await Promise.all([
        requestJson<EconomySummary>(`/api/v1/worlds/${worldId}/economy/summary`),
        requestJson<ReconciliationSummary>(`/api/v1/worlds/${worldId}/economy/reconciliation`),
      ]);
      setSummary(economySummary);
      setReconciliation(reconciliationSummary);
      setProjection(reconciliationSummary.projection);

      if (section === 'resources') {
        const [resources, recipes, inventories] = await Promise.all([
          page<ResourceTypeView>(worldId, 'resources'),
          page<RecipeView>(worldId, 'recipes'),
          page<InventoryView>(worldId, 'inventories'),
        ]);
        setData((current) => ({
          ...current,
          inventories: inventories.items,
          recipes: recipes.items,
          resources: resources.items,
        }));
        setProjection(inventories.projection);
      } else if (section === 'business') {
        const [businesses, facilities, offers, contracts, jobs, walletPage, assets, recipes] =
          await Promise.all([
            page<BusinessView>(worldId, 'businesses'),
            page<FacilityView>(worldId, 'facilities'),
            page<EmploymentOfferView>(worldId, 'employment/offers'),
            page<EmploymentContractView>(worldId, 'employment/contracts'),
            page<JobRecordView>(worldId, 'employment/jobs'),
            requestJson<ControlledWalletPage>(
              `/api/v1/worlds/${worldId}/economy/wallets?limit=100`,
            ),
            requestJson<AssetPage>(`/api/v1/worlds/${worldId}/assets?limit=100&owned=true`),
            page<RecipeView>(worldId, 'recipes'),
          ]);
        setData((current) => ({
          ...current,
          assets: assets.items,
          businesses: businesses.items,
          contracts: contracts.items,
          facilities: facilities.items,
          jobs: jobs.items,
          offers: offers.items,
          recipes: recipes.items,
        }));
        setWallets(walletPage.items);
        setProjection(contracts.projection);
      } else if (section === 'production') {
        const [runs, recipes, facilities, businesses, inventories, resources] = await Promise.all([
          page<ProductionRunView>(worldId, 'production-runs'),
          page<RecipeView>(worldId, 'recipes'),
          page<FacilityView>(worldId, 'facilities'),
          page<BusinessView>(worldId, 'businesses'),
          requestJson<CommercePage<InventoryView>>(
            `/api/v1/worlds/${worldId}/economy/inventories?limit=100&controlled=true`,
          ),
          page<ResourceTypeView>(worldId, 'resources'),
        ]);
        setData((current) => ({
          ...current,
          businesses: businesses.items,
          facilities: facilities.items,
          inventories: inventories.items,
          recipes: recipes.items,
          resources: resources.items,
          runs: runs.items,
        }));
        setProjection(runs.projection);
      } else if (section === 'market') {
        const [listings, trades, inventories, walletPage] = await Promise.all([
          requestJson<CommercePage<MarketListingView>>(
            `/api/v1/worlds/${worldId}/economy/market/listings?limit=50&status=open`,
          ),
          page<MarketTradeView>(worldId, 'market/trades'),
          requestJson<CommercePage<InventoryView>>(
            `/api/v1/worlds/${worldId}/economy/inventories?limit=100&controlled=true`,
          ),
          requestJson<ControlledWalletPage>(`/api/v1/worlds/${worldId}/economy/wallets?limit=100`),
        ]);
        setData((current) => ({
          ...current,
          inventories: inventories.items,
          listings: listings.items,
          trades: trades.items,
        }));
        setWallets(walletPage.items);
        setProjection(listings.projection);
      } else {
        const [treasuryResponse, taxAssessments] = await Promise.all([
          requestJson<{ projection: CommerceProjection; treasury: TreasuryView }>(
            `/api/v1/worlds/${worldId}/economy/treasury`,
          ),
          page<TaxAssessmentView>(worldId, 'tax-assessments'),
        ]);
        setTreasury(treasuryResponse.treasury);
        setData((current) => ({ ...current, taxAssessments: taxAssessments.items }));
        setProjection(treasuryResponse.projection);
      }
    } catch (cause) {
      if (cause instanceof BrowserApiError && cause.status === 401) {
        router.replace(
          `/sign-in?returnTo=${encodeURIComponent(`/worlds/${worldId}/economy/${section}`)}`,
        );
        return;
      }
      setError(failureMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [router, section, worldId]);

  useEffect(() => void load(), [load]);
  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  return (
    <main className="app-page shell wide-shell economy-page commerce-page" id="main-content">
      <header className="app-header runtime-header">
        <Link className="brand-link" href={`/worlds/${worldId}`}>
          ← World workspace
        </Link>
        <WorldEconomyNav current="commerce" worldId={worldId} />
      </header>

      <section className="page-heading economy-heading">
        <div>
          <p className="eyebrow">{copy.eyebrow}</p>
          <h1>{copy.title}</h1>
          <p className="lede compact">{copy.text}</p>
        </div>
        {projection ? (
          <span
            className={`manifest-state ${projection.status === 'current' ? 'approved' : 'draft'}`}
          >
            {projection.status.replaceAll('_', ' ')} · revision {projection.checkpointVersion}
          </span>
        ) : null}
      </section>

      <VirtualValueDisclosure />
      <CommerceSectionNav current={section} worldId={worldId} />
      {projection ? <ProjectionNotice projection={projection} /> : null}
      {error ? (
        <div className="error-summary" ref={errorRef} role="alert" tabIndex={-1}>
          <strong>Commerce data may be stale</strong>
          <p>{error}</p>
          <button className="button secondary" onClick={() => void load()} type="button">
            Refresh authoritative data
          </button>
        </div>
      ) : null}
      {loading ? (
        <section aria-busy="true" aria-live="polite" className="card commerce-loading">
          <div className="skeleton" />
          <div className="skeleton short" />
          <span>Loading authoritative commerce projection…</span>
        </section>
      ) : section === 'resources' ? (
        <ResourcesPanel data={data} />
      ) : section === 'business' ? (
        <BusinessPanel
          data={data}
          onAccepted={load}
          projection={projection}
          reconciliation={reconciliation}
          summary={summary}
          wallets={wallets}
          worldId={worldId}
        />
      ) : section === 'production' ? (
        <ProductionPanel
          data={data}
          onAccepted={load}
          projection={projection}
          reconciliation={reconciliation}
          summary={summary}
          worldId={worldId}
        />
      ) : section === 'market' ? (
        <MarketPanel
          data={data}
          onAccepted={load}
          projection={projection}
          reconciliation={reconciliation}
          summary={summary}
          wallets={wallets}
          worldId={worldId}
        />
      ) : (
        <TreasuryPanel data={data} reconciliation={reconciliation} treasury={treasury} />
      )}
    </main>
  );
}

function CommerceSectionNav({ current, worldId }: { current: CommerceSection; worldId: string }) {
  const links: Array<[CommerceSection, string]> = [
    ['resources', 'Resources'],
    ['business', 'Business & jobs'],
    ['production', 'Production'],
    ['market', 'Marketplace'],
    ['treasury', 'Treasury'],
  ];
  return (
    <nav aria-label="Economy areas" className="commerce-section-nav">
      {links.map(([section, label]) => (
        <Link
          aria-current={current === section ? 'page' : undefined}
          href={`/worlds/${worldId}/economy/${section}`}
          key={section}
        >
          {label}
        </Link>
      ))}
    </nav>
  );
}

function ProjectionNotice({ projection }: { projection: CommerceProjection }) {
  const message = projectionMessage(projection);
  if (!message) return null;
  const dangerous = projection.status === 'failed' || projection.status === 'mismatch';
  const verificationPending =
    projection.status === 'catching_up' && projection.lagRevisions === '0';
  return (
    <section
      className={`economy-state-banner ${dangerous ? 'danger' : 'warning'}`}
      role={dangerous ? 'alert' : 'status'}
    >
      <strong>
        {dangerous
          ? 'Projection conflict'
          : verificationPending
            ? 'Reconciliation pending'
            : 'Projection catching up'}
      </strong>
      <span>{message}</span>
      <span>
        Checkpoint {projection.checkpointVersion} · authoritative revision{' '}
        {projection.currentStateRevision}
      </span>
    </section>
  );
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`commerce-status ${isTerminalCommerceStatus(status) ? 'terminal' : 'active'}`}>
      {status.replaceAll('_', ' ')}
      {isTerminalCommerceStatus(status) ? ' (terminal)' : ''}
    </span>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="empty-state compact-empty" role="status">
      <p>{text}</p>
    </div>
  );
}

function ResourcesPanel({ data }: { data: CommerceData }) {
  return (
    <div className="commerce-stack">
      <section aria-labelledby="inventory-heading" className="card">
        <p className="eyebrow">Available minus reserved</p>
        <h2 id="inventory-heading">Inventories</h2>
        {data.inventories.length === 0 ? (
          <EmptyState text="No inventories are visible in this world." />
        ) : (
          <div className="commerce-card-grid">
            {data.inventories.map((inventory) => (
              <article className="commerce-record" key={inventory.id}>
                <div className="commerce-record-heading">
                  <h3>{inventory.resourceType.displayName}</h3>
                  {inventory.controlledByActor ? <span className="pill">Controlled</span> : null}
                </div>
                <dl className="commerce-facts compact">
                  <div>
                    <dt>Available</dt>
                    <dd>
                      {formatExactQuantity(
                        inventory.availableQuantity,
                        inventory.resourceType.unitCode,
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>Reserved</dt>
                    <dd>
                      {formatExactQuantity(
                        inventory.reservedQuantity,
                        inventory.resourceType.unitCode,
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>Total</dt>
                    <dd>
                      {formatExactQuantity(inventory.quantity, inventory.resourceType.unitCode)}
                    </dd>
                  </div>
                </dl>
                <small>{inventory.ownerEntityKey}</small>
              </article>
            ))}
          </div>
        )}
      </section>
      <section aria-labelledby="resource-heading" className="card">
        <h2 id="resource-heading">Resource definitions</h2>
        {data.resources.length === 0 ? (
          <EmptyState text="No resource definitions have been materialized." />
        ) : (
          <ul className="commerce-list">
            {data.resources.map((resource) => (
              <li key={resource.id}>
                <span>
                  <strong>{resource.displayName}</strong>
                  <small>{resource.stableKey}</small>
                </span>
                <span>
                  {resource.unitCode} · {resource.quantityScale} decimal places
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <RecipeList recipes={data.recipes} />
    </div>
  );
}

function RecipeList({ recipes }: { recipes: RecipeView[] }) {
  return (
    <section aria-labelledby="recipes-heading" className="card">
      <p className="eyebrow">Immutable version snapshots</p>
      <h2 id="recipes-heading">Production recipes</h2>
      {recipes.length === 0 ? (
        <EmptyState text="No production recipes are available." />
      ) : (
        <div className="commerce-card-grid">
          {recipes.map((recipe) => (
            <article className="commerce-record" key={recipe.id}>
              <h3>Recipe version {recipe.version}</h3>
              <p>Duration: {recipe.durationTicks} ticks</p>
              <p>
                {recipe.inputs.length} input{recipe.inputs.length === 1 ? '' : 's'} →{' '}
                {recipe.outputs.length} output{recipe.outputs.length === 1 ? '' : 's'}
              </p>
              <CopyableId id={recipe.id} label="recipe version ID" />
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function commerceActionBlockReason(
  summary: EconomySummary | null,
  projection: CommerceProjection | null,
  reconciliation: ReconciliationSummary | null,
): string | null {
  if (!summary || !projection || !reconciliation) {
    return 'Authoritative command versions are unavailable. Refresh before changing commerce state.';
  }
  if (summary.status === 'mismatched' || summary.reconciliation.status === 'mismatched') {
    return 'Core economy reconciliation is mismatched. Commerce actions are read-only.';
  }
  if (!commerceProjectionAllowsActions(projection)) {
    return 'Commerce actions are paused while the projection catches up to authoritative state.';
  }
  if (reconciliation.lastRun?.status === 'mismatch') {
    return 'Commerce reconciliation found a mismatch. A reviewed append-only repair is required.';
  }
  if (summary.featurePolicy.debitsFrozen) {
    return 'World policy currently freezes virtual-value debits and dependent commerce actions.';
  }
  return null;
}

function contractIsInWindow(contract: EmploymentContractView, currentTick: string): boolean {
  try {
    const tick = BigInt(currentTick);
    return tick >= BigInt(contract.effectiveFromTick) && tick < BigInt(contract.effectiveToTick);
  } catch {
    return false;
  }
}

function BusinessPanel({
  data,
  onAccepted,
  projection,
  reconciliation,
  summary,
  wallets,
  worldId,
}: {
  data: CommerceData;
  onAccepted: () => Promise<void>;
  projection: CommerceProjection | null;
  reconciliation: ReconciliationSummary | null;
  summary: EconomySummary | null;
  wallets: ControlledWalletView[];
  worldId: string;
}) {
  const [businessWalletId, setBusinessWalletId] = useState('');
  const [facilityBusinessId, setFacilityBusinessId] = useState('');
  const [facilityAssetId, setFacilityAssetId] = useState('');
  const [facilityRecipeIds, setFacilityRecipeIds] = useState<string[]>([]);
  const [contractBusinessId, setContractBusinessId] = useState('');
  const [employmentCandidates, setEmploymentCandidates] = useState<EmploymentCandidateView[]>([]);
  const [candidateCursor, setCandidateCursor] = useState<string | null>(null);
  const [candidateLoading, setCandidateLoading] = useState(false);
  const [candidateError, setCandidateError] = useState('');
  const [workerWalletId, setWorkerWalletId] = useState('');
  const [contractRole, setContractRole] = useState('');
  const [contractWage, setContractWage] = useState('');
  const [contractCooldown, setContractCooldown] = useState('1');
  const [contractPeriod, setContractPeriod] = useState('10');
  const [contractMaxPerformances, setContractMaxPerformances] = useState('1');
  const [contractRewardCap, setContractRewardCap] = useState('');
  const [contractFromTick, setContractFromTick] = useState('');
  const [contractToTick, setContractToTick] = useState('');
  const [endingContractId, setEndingContractId] = useState('');
  const [endReason, setEndReason] = useState('');
  const endHeadingRef = useRef<HTMLHeadingElement>(null);
  const candidateRequestRef = useRef(0);
  const blockReason = commerceActionBlockReason(summary, projection, reconciliation);
  const businessWallets = useMemo(
    () =>
      wallets.filter(
        (wallet) =>
          wallet.wallet.walletKind === 'organization' &&
          wallet.wallet.status === 'active' &&
          !data.businesses.some(
            (business) =>
              business.walletId === wallet.wallet.id ||
              business.backingOrganizationEntityKey === wallet.wallet.ownerEntityLogicalKey,
          ),
      ),
    [data.businesses, wallets],
  );
  const selectedBusinessWallet =
    businessWallets.find((wallet) => wallet.wallet.id === businessWalletId) ?? null;
  const manageableBusinesses = data.businesses.filter(
    (business) => business.canManage && business.status === 'active',
  );
  const facilityBusiness =
    manageableBusinesses.find((business) => business.id === facilityBusinessId) ?? null;
  const facilityAssets = data.assets.filter(
    (view) =>
      view.controlledByActor &&
      view.asset.status === 'active' &&
      view.ownership.ownerEntityLogicalKey === facilityBusiness?.backingOrganizationEntityKey &&
      !data.facilities.some((facility) => facility.facilityAssetId === view.asset.id),
  );
  const facilityAsset = facilityAssets.find((view) => view.asset.id === facilityAssetId) ?? null;
  const compatibleFacilityRecipes = data.recipes.filter(
    (recipe) => recipe.facilityAssetType === facilityAsset?.asset.assetType,
  );
  const contractBusiness =
    manageableBusinesses.find((business) => business.id === contractBusinessId) ?? null;
  const employerWallet =
    wallets.find((wallet) => wallet.wallet.id === contractBusiness?.walletId) ?? null;
  const employmentCandidate =
    employmentCandidates.find(
      (candidate) =>
        candidate.businessId === contractBusiness?.id &&
        candidate.workerWalletId === workerWalletId,
    ) ?? null;
  const candidateMatchesCurrency =
    Boolean(employmentCandidate) &&
    Boolean(employerWallet) &&
    employmentCandidate?.currencyId === employerWallet?.wallet.currencyId;
  const wagePreview = employerWallet
    ? previewAmount(contractWage, employerWallet.minorUnitScale)
    : null;
  const rewardCapPreview = employerWallet
    ? previewAmount(contractRewardCap, employerWallet.minorUnitScale)
    : null;
  const roleIsValid = /^[a-z][a-z0-9_]{0,79}$/u.test(contractRole);
  const maxPerformances = Number(contractMaxPerformances);
  const termsAreBounded = (() => {
    if (
      !summary ||
      !/^(?:0|[1-9][0-9]*)$/u.test(contractCooldown) ||
      !/^[1-9][0-9]*$/u.test(contractPeriod) ||
      !/^(?:0|[1-9][0-9]*)$/u.test(contractFromTick) ||
      !/^(?:0|[1-9][0-9]*)$/u.test(contractToTick) ||
      !Number.isInteger(maxPerformances) ||
      maxPerformances < 1 ||
      maxPerformances > 100
    ) {
      return false;
    }
    try {
      const cooldown = BigInt(contractCooldown);
      const period = BigInt(contractPeriod);
      const fromTick = BigInt(contractFromTick);
      const toTick = BigInt(contractToTick);
      return (
        cooldown <= MAX_SIGNED_INT64 &&
        period >= 1n &&
        period <= MAX_SIGNED_INT64 &&
        fromTick >= BigInt(summary.currentTick) &&
        fromTick <= MAX_SIGNED_INT64 &&
        toTick > fromTick &&
        toTick <= MAX_SIGNED_INT64
      );
    } catch {
      return false;
    }
  })();
  const rewardCoversWage =
    wagePreview?.ok && rewardCapPreview?.ok
      ? BigInt(rewardCapPreview.value.minor) >= BigInt(wagePreview.value.minor)
      : false;
  const endingContract =
    data.contracts.find((contract) => contract.id === endingContractId) ?? null;
  const refreshAfterAccepted = useCallback(async () => {
    setEndingContractId('');
    setEndReason('');
    setBusinessWalletId('');
    setFacilityBusinessId('');
    setFacilityAssetId('');
    setFacilityRecipeIds([]);
    setContractBusinessId('');
    setEmploymentCandidates([]);
    setCandidateCursor(null);
    setCandidateError('');
    setWorkerWalletId('');
    setContractRole('');
    setContractWage('');
    setContractRewardCap('');
    setContractFromTick('');
    setContractToTick('');
    await onAccepted();
  }, [onAccepted]);
  const command = useEconomyCommand({
    onAccepted: refreshAfterAccepted,
    returnPath: `/worlds/${worldId}/economy/business`,
    summary,
    worldId,
  });

  useEffect(() => {
    if (endingContract) endHeadingRef.current?.focus();
  }, [endingContract]);

  const loadEmploymentCandidates = useCallback(
    async (businessId: string, cursor?: string, append = false) => {
      const requestId = ++candidateRequestRef.current;
      setCandidateLoading(true);
      setCandidateError('');
      try {
        const query = new URLSearchParams({ limit: '50' });
        if (cursor) query.set('cursor', cursor);
        const response = await requestJson<CommercePage<EmploymentCandidateView>>(
          `/api/v1/worlds/${worldId}/economy/businesses/${businessId}/employment-candidates?${query.toString()}`,
        );
        if (requestId !== candidateRequestRef.current) return;
        setEmploymentCandidates((current) =>
          append ? [...current, ...response.items] : response.items,
        );
        setCandidateCursor(response.nextCursor);
      } catch (cause) {
        if (requestId !== candidateRequestRef.current) return;
        setEmploymentCandidates([]);
        setCandidateCursor(null);
        setCandidateError(failureMessage(cause));
      } finally {
        if (requestId === candidateRequestRef.current) setCandidateLoading(false);
      }
    },
    [worldId],
  );

  useEffect(() => {
    candidateRequestRef.current += 1;
    setCandidateLoading(false);
    setWorkerWalletId('');
    setEmploymentCandidates([]);
    setCandidateCursor(null);
    setCandidateError('');
    if (contractBusinessId) void loadEmploymentCandidates(contractBusinessId);
  }, [contractBusinessId, loadEmploymentCandidates]);

  function submit(
    type:
      | 'AcceptEmploymentContractV1'
      | 'ConfigureBusinessFacilityV1'
      | 'CreateBusinessV1'
      | 'CreateEmploymentContractV1'
      | 'EndEmploymentContractV1'
      | 'PerformJobV1',
    payload: Record<string, unknown>,
  ) {
    if (!reconciliation || blockReason) return;
    void command.submit(type, payload, reconciliation.expansionVersion);
  }

  return (
    <div className="commerce-stack">
      <CommandFeedback check={command.check} retry={command.retry} state={command.state} />
      {blockReason ? (
        <p className="danger-text" role="status">
          {blockReason}
        </p>
      ) : null}
      <section aria-labelledby="business-heading" className="card">
        <h2 id="business-heading">Businesses & facilities</h2>
        {data.businesses.length === 0 ? (
          <EmptyState text="No businesses have been created." />
        ) : (
          <div className="commerce-card-grid">
            {data.businesses.map((business) => {
              const facilities = data.facilities.filter((item) => item.businessId === business.id);
              return (
                <article className="commerce-record" key={business.id}>
                  <div className="commerce-record-heading">
                    <h3>{business.backingOrganizationEntityKey}</h3>
                    <StatusBadge status={business.status} />
                  </div>
                  <p>{facilities.length} configured facility record(s)</p>
                  <p>{business.canManage ? 'You can manage this business.' : 'Read-only view.'}</p>
                  <CopyableId id={business.id} label="business ID" />
                </article>
              );
            })}
          </div>
        )}
      </section>
      <section aria-labelledby="create-business-heading" className="card">
        <p className="eyebrow">Controlled organization wallet</p>
        <h2 id="create-business-heading">Create a business specialization</h2>
        {businessWallets.length === 0 ? (
          <EmptyState text="Every visible controlled organization wallet already backs a business, or no eligible organization wallet is visible." />
        ) : (
          <form
            className="form-stack"
            onSubmit={(event) => {
              event.preventDefault();
              if (!selectedBusinessWallet) return;
              submit('CreateBusinessV1', {
                backingOrganizationEntityKey: selectedBusinessWallet.wallet.ownerEntityLogicalKey,
                walletId: selectedBusinessWallet.wallet.id,
              });
            }}
          >
            <label>
              Organization and active wallet
              <select
                disabled={command.pending}
                onChange={(event) => setBusinessWalletId(event.currentTarget.value)}
                required
                value={businessWalletId}
              >
                <option value="">Choose a controlled organization</option>
                {businessWallets.map((wallet) => (
                  <option key={wallet.wallet.id} value={wallet.wallet.id}>
                    {wallet.wallet.ownerEntityLogicalKey} · {wallet.currencyCode}
                  </option>
                ))}
              </select>
            </label>
            <p className="field-help">
              The server rechecks organization control, wallet ownership, world scope, and the
              one-business-per-organization constraint.
            </p>
            <button
              className="button"
              disabled={command.pending || Boolean(blockReason) || !selectedBusinessWallet}
              type="submit"
            >
              Create business
            </button>
          </form>
        )}
      </section>
      <section aria-labelledby="configure-facility-heading" className="card">
        <p className="eyebrow">Owned asset and compatible recipes</p>
        <h2 id="configure-facility-heading">Configure a production facility</h2>
        {manageableBusinesses.length === 0 ? (
          <EmptyState text="No active business controlled by this participant is available for facility configuration." />
        ) : (
          <form
            className="form-stack"
            onSubmit={(event) => {
              event.preventDefault();
              if (!facilityBusiness || !facilityAsset || facilityRecipeIds.length === 0) return;
              submit('ConfigureBusinessFacilityV1', {
                businessId: facilityBusiness.id,
                expectedBusinessVersion: facilityBusiness.rowVersion,
                expectedOwnershipVersion: facilityAsset.ownership.ownershipVersion,
                facilityAssetId: facilityAsset.asset.id,
                recipeVersionIds: [...facilityRecipeIds].sort(),
              });
            }}
          >
            <label>
              Managed business
              <select
                onChange={(event) => {
                  setFacilityBusinessId(event.currentTarget.value);
                  setFacilityAssetId('');
                  setFacilityRecipeIds([]);
                }}
                required
                value={facilityBusinessId}
              >
                <option value="">Choose a business</option>
                {manageableBusinesses.map((business) => (
                  <option key={business.id} value={business.id}>
                    {business.backingOrganizationEntityKey} · version {business.rowVersion}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Unconfigured asset owned by the business organization
              <select
                disabled={!facilityBusiness}
                onChange={(event) => {
                  setFacilityAssetId(event.currentTarget.value);
                  setFacilityRecipeIds([]);
                }}
                required
                value={facilityAssetId}
              >
                <option value="">Choose an owned asset</option>
                {facilityAssets.map((view) => (
                  <option key={view.asset.id} value={view.asset.id}>
                    {view.asset.metadata.displayName} · {view.asset.assetType} · ownership version{' '}
                    {view.ownership.ownershipVersion}
                  </option>
                ))}
              </select>
            </label>
            {facilityBusiness && facilityAssets.length === 0 ? (
              <p className="field-help" role="status">
                No active, controlled, unconfigured asset is owned by this business organization.
              </p>
            ) : null}
            {facilityAsset ? (
              <fieldset>
                <legend>Compatible immutable recipe versions</legend>
                {compatibleFacilityRecipes.length === 0 ? (
                  <p className="danger-text" role="status">
                    No recipe requires asset type {facilityAsset.asset.assetType}.
                  </p>
                ) : (
                  compatibleFacilityRecipes.map((recipe) => (
                    <label className="checkbox-row" key={recipe.id}>
                      <input
                        checked={facilityRecipeIds.includes(recipe.id)}
                        onChange={(event) =>
                          setFacilityRecipeIds((current) =>
                            event.currentTarget.checked
                              ? [...current, recipe.id]
                              : current.filter((id) => id !== recipe.id),
                          )
                        }
                        type="checkbox"
                      />
                      Recipe version {recipe.version} · {recipe.durationTicks} ticks · requires{' '}
                      {recipe.facilityAssetType}
                    </label>
                  ))
                )}
              </fieldset>
            ) : null}
            <p className="field-help">
              Only controlled title records are offered. The server rechecks exact ownership,
              business and ownership versions, and every recipe’s facility requirement.
            </p>
            <button
              className="button"
              disabled={
                command.pending ||
                Boolean(blockReason) ||
                !facilityBusiness ||
                !facilityAsset ||
                facilityRecipeIds.length === 0
              }
              type="submit"
            >
              Configure facility
            </button>
          </form>
        )}
      </section>
      <section aria-labelledby="offers-heading" className="card">
        <h2 id="offers-heading">Employment offers</h2>
        {data.offers.length === 0 ? (
          <EmptyState text="No employment offers are open or retained." />
        ) : (
          <ul className="commerce-list">
            {data.offers.map((offer) => (
              <li key={offer.id}>
                <span>
                  <strong>{offer.roleCode.replaceAll('_', ' ')}</strong>
                  <small>{offer.wageMinor} minor units per cadence</small>
                </span>
                <StatusBadge status={offer.status} />
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby="create-contract-heading" className="card">
        <p className="eyebrow">Private offer to an eligible participant</p>
        <h2 id="create-contract-heading">Create an employment contract</h2>
        {manageableBusinesses.length === 0 ? (
          <EmptyState text="No active controlled business is available to offer a contract." />
        ) : (
          <form
            className="form-stack"
            onSubmit={(event) => {
              event.preventDefault();
              if (
                !contractBusiness ||
                !employerWallet ||
                !employmentCandidate ||
                !candidateMatchesCurrency ||
                !wagePreview?.ok ||
                !rewardCapPreview?.ok ||
                !rewardCoversWage ||
                !roleIsValid ||
                !termsAreBounded
              ) {
                return;
              }
              submit('CreateEmploymentContractV1', {
                businessId: contractBusiness.id,
                cooldownTicks: contractCooldown,
                effectiveFromTick: contractFromTick,
                effectiveToTick: contractToTick,
                employerWalletId: employerWallet.wallet.id,
                expectedBusinessVersion: contractBusiness.rowVersion,
                maxPerformancesPerPeriod: maxPerformances,
                periodTicks: contractPeriod,
                rewardCapMinor: rewardCapPreview.value.minor,
                roleCode: contractRole,
                wageMinor: wagePreview.value.minor,
                wageRuleKind: 'per_shift',
                workerEntityKey: employmentCandidate.workerEntityKey,
                workerWalletId: employmentCandidate.workerWalletId,
              });
            }}
          >
            <label>
              Managed employer business
              <select
                onChange={(event) => {
                  setContractBusinessId(event.currentTarget.value);
                  setContractFromTick(summary?.currentTick ?? '');
                  setContractToTick('');
                }}
                required
                value={contractBusinessId}
              >
                <option value="">Choose a business</option>
                {manageableBusinesses.map((business) => (
                  <option key={business.id} value={business.id}>
                    {business.backingOrganizationEntityKey} · version {business.rowVersion}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Eligible worker and active wallet
              <select
                disabled={!contractBusiness || candidateLoading}
                onChange={(event) => setWorkerWalletId(event.currentTarget.value)}
                required
                value={workerWalletId}
              >
                <option value="">
                  {candidateLoading ? 'Loading authorized candidates…' : 'Choose a worker'}
                </option>
                {employmentCandidates
                  .filter((candidate) => candidate.businessId === contractBusiness?.id)
                  .map((candidate) => (
                    <option key={candidate.workerWalletId} value={candidate.workerWalletId}>
                      {candidate.workerEntityKey} · wallet {candidate.workerWalletId}
                    </option>
                  ))}
              </select>
            </label>
            {candidateError ? (
              <p className="danger-text" role="alert">
                {candidateError}
              </p>
            ) : null}
            {candidateCursor && contractBusiness ? (
              <button
                className="button secondary"
                disabled={candidateLoading}
                onClick={() =>
                  void loadEmploymentCandidates(contractBusiness.id, candidateCursor, true)
                }
                type="button"
              >
                Load more eligible workers
              </button>
            ) : null}
            <label>
              Role code
              <input
                autoComplete="off"
                onChange={(event) => setContractRole(event.currentTarget.value.trim())}
                pattern="[a-z][a-z0-9_]{0,79}"
                placeholder="forge_operator"
                required
                value={contractRole}
              />
            </label>
            <div className="economy-two-fields">
              <label>
                Wage per shift in {employerWallet?.currencyCode ?? 'virtual currency'}
                <input
                  inputMode="decimal"
                  onChange={(event) => setContractWage(event.currentTarget.value.trim())}
                  placeholder={employerWallet?.minorUnitScale === 0 ? '25' : '25.00'}
                  required
                  value={contractWage}
                />
              </label>
              <label>
                Reward cap per period in {employerWallet?.currencyCode ?? 'virtual currency'}
                <input
                  inputMode="decimal"
                  onChange={(event) => setContractRewardCap(event.currentTarget.value.trim())}
                  placeholder={employerWallet?.minorUnitScale === 0 ? '100' : '100.00'}
                  required
                  value={contractRewardCap}
                />
              </label>
            </div>
            <div className="economy-two-fields">
              <label>
                Effective from tick
                <input
                  inputMode="numeric"
                  onChange={(event) => setContractFromTick(event.currentTarget.value.trim())}
                  pattern="(?:0|[1-9][0-9]*)"
                  required
                  value={contractFromTick}
                />
              </label>
              <label>
                Effective until tick
                <input
                  inputMode="numeric"
                  onChange={(event) => setContractToTick(event.currentTarget.value.trim())}
                  pattern="(?:0|[1-9][0-9]*)"
                  required
                  value={contractToTick}
                />
              </label>
            </div>
            <div className="economy-two-fields">
              <label>
                Cooldown ticks
                <input
                  inputMode="numeric"
                  onChange={(event) => setContractCooldown(event.currentTarget.value.trim())}
                  pattern="(?:0|[1-9][0-9]*)"
                  required
                  value={contractCooldown}
                />
              </label>
              <label>
                Period ticks
                <input
                  inputMode="numeric"
                  onChange={(event) => setContractPeriod(event.currentTarget.value.trim())}
                  pattern="[1-9][0-9]*"
                  required
                  value={contractPeriod}
                />
              </label>
            </div>
            <label>
              Maximum performances per period (1–100)
              <input
                inputMode="numeric"
                max={100}
                min={1}
                onChange={(event) => setContractMaxPerformances(event.currentTarget.value.trim())}
                required
                type="number"
                value={contractMaxPerformances}
              />
            </label>
            <div aria-live="polite" className="amount-preview">
              <strong>Bounded virtual compensation · no cash value</strong>
              {wagePreview?.ok && employerWallet ? (
                <span>
                  Wage: {wagePreview.value.canonical} {employerWallet.currencyCode} (
                  {wagePreview.value.minor} minor units)
                </span>
              ) : contractWage && wagePreview && !wagePreview.ok ? (
                <span className="danger-text">{wagePreview.message}</span>
              ) : null}
              {rewardCapPreview?.ok && employerWallet ? (
                <span>
                  Period cap: {rewardCapPreview.value.canonical} {employerWallet.currencyCode} (
                  {rewardCapPreview.value.minor} minor units)
                </span>
              ) : contractRewardCap && rewardCapPreview && !rewardCapPreview.ok ? (
                <span className="danger-text">{rewardCapPreview.message}</span>
              ) : null}
              {wagePreview?.ok && rewardCapPreview?.ok && !rewardCoversWage ? (
                <span className="danger-text">Reward cap must cover at least one wage.</span>
              ) : null}
              {(contractFromTick || contractToTick) && !termsAreBounded ? (
                <span className="danger-text">
                  Contract ticks must begin no earlier than tick {summary?.currentTick ?? '—'} and
                  end later; cadence and limits must be positive and bounded.
                </span>
              ) : null}
            </div>
            <p className="field-help">
              Worker discovery is scoped to this controlled business and returns only an active
              player-character key and matching wallet ID. Account identity, balances, and other
              private contracts are never included.
            </p>
            <button
              className="button"
              disabled={
                command.pending ||
                Boolean(blockReason) ||
                !contractBusiness ||
                !employerWallet ||
                !employmentCandidate ||
                !candidateMatchesCurrency ||
                !wagePreview?.ok ||
                !rewardCapPreview?.ok ||
                !rewardCoversWage ||
                !roleIsValid ||
                !termsAreBounded
              }
              type="submit"
            >
              Offer employment contract
            </button>
          </form>
        )}
      </section>
      <section aria-labelledby="contracts-heading" className="card">
        <p className="eyebrow">Participant-private terms</p>
        <h2 id="contracts-heading">Your visible contracts & jobs</h2>
        {data.contracts.length === 0 ? (
          <EmptyState text="No participant or managed-business contracts are visible to you." />
        ) : (
          <div className="commerce-card-grid">
            {data.contracts.map((contract) => (
              <article className="commerce-record" key={contract.id}>
                <div className="commerce-record-heading">
                  <h3>{contract.roleCode.replaceAll('_', ' ')}</h3>
                  <StatusBadge status={contract.status} />
                </div>
                <p>Worker: {contract.workerEntityKey}</p>
                <p>Compensation: {contract.wageMinor ?? 'private'} minor units</p>
                <p>
                  {contract.canWork ? 'Work action available' : 'Work action unavailable'} ·{' '}
                  {contract.canManage ? 'manager view' : 'participant view'}
                </p>
                <div className="economy-inline-actions">
                  {contract.status === 'offered' && contract.canWork ? (
                    <button
                      className="button secondary"
                      disabled={command.pending || Boolean(blockReason)}
                      onClick={() =>
                        submit('AcceptEmploymentContractV1', {
                          contractId: contract.id,
                          expectedContractVersion: contract.rowVersion,
                        })
                      }
                      type="button"
                    >
                      Accept employment contract
                    </button>
                  ) : null}
                  {contract.status === 'active' && contract.canWork ? (
                    <button
                      className="button secondary"
                      disabled={
                        command.pending ||
                        Boolean(blockReason) ||
                        !summary ||
                        !contractIsInWindow(contract, summary.currentTick)
                      }
                      onClick={() =>
                        submit('PerformJobV1', {
                          contractId: contract.id,
                          expectedContractVersion: contract.rowVersion,
                        })
                      }
                      type="button"
                    >
                      Perform one bounded job
                    </button>
                  ) : null}
                  {contract.status === 'active' && (contract.canWork || contract.canManage) ? (
                    <button
                      className="text-button danger-text"
                      disabled={command.pending || Boolean(blockReason)}
                      onClick={() => {
                        setEndingContractId(contract.id);
                        setEndReason('');
                      }}
                      type="button"
                    >
                      Review contract termination
                    </button>
                  ) : null}
                </div>
                {contract.status === 'active' &&
                contract.canWork &&
                summary &&
                !contractIsInWindow(contract, summary.currentTick) ? (
                  <small role="status">
                    Work is unavailable outside ticks {contract.effectiveFromTick}–
                    {contract.effectiveToTick}.
                  </small>
                ) : null}
              </article>
            ))}
          </div>
        )}
        {endingContract ? (
          <section
            aria-labelledby="end-contract-heading"
            className="purchase-confirmation"
            role="dialog"
          >
            <h3 id="end-contract-heading" ref={endHeadingRef} tabIndex={-1}>
              Confirm contract termination
            </h3>
            <p>
              Ending is terminal. It stops future work under this contract but does not erase
              immutable work or payroll history.
            </p>
            <form
              className="form-stack"
              onSubmit={(event) => {
                event.preventDefault();
                submit('EndEmploymentContractV1', {
                  contractId: endingContract.id,
                  expectedContractVersion: endingContract.rowVersion,
                  reason: endReason.trim(),
                });
              }}
            >
              <label>
                Auditable termination reason
                <textarea
                  maxLength={240}
                  minLength={8}
                  onChange={(event) => setEndReason(event.currentTarget.value)}
                  required
                  value={endReason}
                />
              </label>
              <div className="economy-inline-actions">
                <button
                  className="button danger-button"
                  disabled={command.pending || endReason.trim().length < 8}
                  type="submit"
                >
                  End contract permanently
                </button>
                <button
                  className="button secondary"
                  onClick={() => {
                    setEndingContractId('');
                    setEndReason('');
                  }}
                  type="button"
                >
                  Keep contract active
                </button>
              </div>
            </form>
          </section>
        ) : null}
        <h3>Recent job outcomes</h3>
        {data.jobs.length === 0 ? (
          <EmptyState text="No private work records are visible." />
        ) : (
          <ul className="commerce-list">
            {data.jobs.map((job) => (
              <li key={job.id}>
                <span>
                  <strong>Tick {job.performedTick}</strong>
                  <small>{job.grossMinor} gross minor units</small>
                </span>
                <StatusBadge status={job.payroll?.status ?? 'pending'} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function ProductionPanel({
  data,
  onAccepted,
  projection,
  reconciliation,
  summary,
  worldId,
}: {
  data: CommerceData;
  onAccepted: () => Promise<void>;
  projection: CommerceProjection | null;
  reconciliation: ReconciliationSummary | null;
  summary: EconomySummary | null;
  worldId: string;
}) {
  const [businessId, setBusinessId] = useState('');
  const [facilityId, setFacilityId] = useState('');
  const [recipeId, setRecipeId] = useState('');
  const [runQuantity, setRunQuantity] = useState('');
  const blockReason = commerceActionBlockReason(summary, projection, reconciliation);
  const manageableBusinesses = data.businesses.filter(
    (business) => business.canManage && business.status === 'active',
  );
  const selectedBusiness =
    manageableBusinesses.find((business) => business.id === businessId) ?? null;
  const eligibleFacilities = data.facilities.filter(
    (facility) => facility.businessId === selectedBusiness?.id && facility.status === 'active',
  );
  const selectedFacility =
    eligibleFacilities.find((facility) => facility.id === facilityId) ?? null;
  const eligibleRecipes = data.recipes.filter((recipe) =>
    selectedFacility?.recipeVersionIds.includes(recipe.id),
  );
  const selectedRecipe = eligibleRecipes.find((recipe) => recipe.id === recipeId) ?? null;
  const inventorySelection = selectedRecipe
    ? selectProductionInventories(
        selectedRecipe,
        data.inventories.filter(
          (inventory) =>
            inventory.ownerEntityKey === selectedBusiness?.backingOrganizationEntityKey,
        ),
        selectedFacility?.facilityAssetId ?? '',
      )
    : null;
  const quantityResult = positiveWholeRunQuantity(runQuantity);
  const command = useEconomyCommand({
    onAccepted,
    returnPath: `/worlds/${worldId}/economy/production`,
    summary,
    worldId,
  });

  function startRun(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      !selectedBusiness ||
      !selectedFacility ||
      !selectedRecipe ||
      !inventorySelection?.ok ||
      !quantityResult.ok ||
      !reconciliation ||
      blockReason
    ) {
      return;
    }
    void command.submit(
      'StartProductionRunV1',
      {
        businessId: selectedBusiness.id,
        expectedBusinessVersion: selectedBusiness.rowVersion,
        expectedFacilityVersion: selectedFacility.rowVersion,
        expectedInventories: inventorySelection.expectedInventories,
        facilityId: selectedFacility.id,
        recipeVersionId: selectedRecipe.id,
        runQuantity: quantityResult.canonical,
      },
      reconciliation.expansionVersion,
    );
  }

  return (
    <div className="commerce-stack">
      <CommandFeedback check={command.check} retry={command.retry} state={command.state} />
      <section aria-labelledby="start-production-heading" className="card">
        <p className="eyebrow">Version-checked reservation</p>
        <h2 id="start-production-heading">Start a production run</h2>
        {manageableBusinesses.length === 0 ? (
          <EmptyState text="No active business manageable by this participant is available for production." />
        ) : (
          <form className="form-stack" onSubmit={startRun}>
            <label>
              Managed business
              <select
                onChange={(event) => {
                  setBusinessId(event.currentTarget.value);
                  setFacilityId('');
                  setRecipeId('');
                }}
                required
                value={businessId}
              >
                <option value="">Choose a business</option>
                {manageableBusinesses.map((business) => (
                  <option key={business.id} value={business.id}>
                    {business.backingOrganizationEntityKey} · version {business.rowVersion}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Active facility
              <select
                disabled={!selectedBusiness}
                onChange={(event) => {
                  setFacilityId(event.currentTarget.value);
                  setRecipeId('');
                }}
                required
                value={facilityId}
              >
                <option value="">Choose a configured facility</option>
                {eligibleFacilities.map((facility) => (
                  <option key={facility.id} value={facility.id}>
                    {facility.id} · version {facility.rowVersion}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Enabled immutable recipe version
              <select
                disabled={!selectedFacility}
                onChange={(event) => setRecipeId(event.currentTarget.value)}
                required
                value={recipeId}
              >
                <option value="">Choose a recipe</option>
                {eligibleRecipes.map((recipe) => (
                  <option key={recipe.id} value={recipe.id}>
                    Version {recipe.version} · {recipe.durationTicks} ticks
                  </option>
                ))}
              </select>
            </label>
            <label>
              Whole run quantity
              <input
                inputMode="numeric"
                onChange={(event) => setRunQuantity(event.currentTarget.value.trim())}
                pattern="[1-9][0-9]{0,17}"
                required
                value={runQuantity}
              />
            </label>
            {selectedRecipe ? (
              <div aria-live="polite" className="amount-preview">
                <strong>Exact recipe amounts per run</strong>
                {selectedRecipe.inputs.map((input) => {
                  const resource = data.resources.find((item) => item.id === input.resourceTypeId);
                  return (
                    <span key={`input-${input.resourceTypeId}`}>
                      Input:{' '}
                      {resource
                        ? formatExactQuantity(input.quantity, resource.unitCode)
                        : input.quantity}
                    </span>
                  );
                })}
                {selectedRecipe.outputs.map((output) => {
                  const resource = data.resources.find((item) => item.id === output.resourceTypeId);
                  return (
                    <span key={`output-${output.resourceTypeId}`}>
                      Output:{' '}
                      {resource
                        ? formatExactQuantity(output.quantity, resource.unitCode)
                        : output.quantity}
                    </span>
                  );
                })}
                {inventorySelection && !inventorySelection.ok ? (
                  <span className="danger-text">{inventorySelection.message}</span>
                ) : null}
                {runQuantity && !quantityResult.ok ? (
                  <span className="danger-text">{quantityResult.message}</span>
                ) : null}
              </div>
            ) : null}
            {blockReason ? (
              <p className="danger-text" role="status">
                {blockReason}
              </p>
            ) : null}
            <p className="field-help">
              The command includes the current business, facility, tick, expansion, and every
              selected input-inventory version. The server recomputes exact reservations and the due
              tick from the immutable recipe.
            </p>
            <button
              className="button"
              disabled={
                command.pending ||
                Boolean(blockReason) ||
                !selectedBusiness ||
                !selectedFacility ||
                !selectedRecipe ||
                !inventorySelection?.ok ||
                !quantityResult.ok
              }
              type="submit"
            >
              Reserve inputs and schedule run
            </button>
          </form>
        )}
      </section>
      <section aria-labelledby="runs-heading" className="card">
        <h2 id="runs-heading">Production runs</h2>
        {data.runs.length === 0 ? (
          <EmptyState text="No production runs have been scheduled." />
        ) : (
          <div className="commerce-card-grid">
            {data.runs.map((run) => (
              <article className="commerce-record" key={run.id}>
                <div className="commerce-record-heading">
                  <h3>Due tick {run.dueTick}</h3>
                  <StatusBadge status={run.status} />
                </div>
                <p>Run quantity: {run.runQuantity}</p>
                <p>
                  {run.inputSnapshot.length} reserved input(s) → {run.outputSnapshot.length}{' '}
                  output(s)
                </p>
                {run.failureCode ? <p className="danger-text">{run.failureCode}</p> : null}
                <CopyableId id={run.id} label="production run ID" />
              </article>
            ))}
          </div>
        )}
      </section>
      <RecipeList recipes={data.recipes} />
    </div>
  );
}

function MarketPanel({
  data,
  onAccepted,
  projection,
  reconciliation,
  summary,
  wallets,
  worldId,
}: {
  data: CommerceData;
  onAccepted: () => Promise<void>;
  projection: CommerceProjection | null;
  reconciliation: ReconciliationSummary | null;
  summary: EconomySummary | null;
  wallets: ControlledWalletView[];
  worldId: string;
}) {
  const [selectedListingId, setSelectedListingId] = useState('');
  const [quantity, setQuantity] = useState('');
  const [preview, setPreview] = useState<PurchasePreview | null>(null);
  const [previewError, setPreviewError] = useState('');
  const [previewLoading, setPreviewLoading] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [walletId, setWalletId] = useState('');
  const [inventoryId, setInventoryId] = useState('');
  const [listingInventoryId, setListingInventoryId] = useState('');
  const [listingWalletId, setListingWalletId] = useState('');
  const [listingQuantity, setListingQuantity] = useState('');
  const [listingPrice, setListingPrice] = useState('');
  const [listingExpiry, setListingExpiry] = useState('');
  const [cancellationListingId, setCancellationListingId] = useState('');
  const [cancellationConfirmed, setCancellationConfirmed] = useState(false);
  const cancellationHeadingRef = useRef<HTMLHeadingElement>(null);
  const selected = data.listings.find((listing) => listing.id === selectedListingId) ?? null;
  const wallet = wallets.find((item) => item.wallet.id === walletId) ?? null;
  const listingInventory = data.inventories.find((item) => item.id === listingInventoryId) ?? null;
  const listingWallet = wallets.find((item) => item.wallet.id === listingWalletId) ?? null;
  const cancellationListing =
    data.listings.find((listing) => listing.id === cancellationListingId) ?? null;
  const matchingInventories = useMemo(
    () =>
      data.inventories.filter(
        (inventory) =>
          inventory.resourceType.id === selected?.resourceType.id &&
          (!wallet || inventory.ownerEntityKey === wallet.wallet.ownerEntityLogicalKey),
      ),
    [data.inventories, selected?.resourceType.id, wallet],
  );
  const inventory = matchingInventories.find((item) => item.id === inventoryId) ?? null;
  const sellerWallets = wallets.filter(
    (item) =>
      item.wallet.status === 'active' &&
      item.wallet.ownerEntityLogicalKey === listingInventory?.ownerEntityKey,
  );
  const listingQuantityResult = listingInventory
    ? exactPositiveQuantity(listingQuantity, listingInventory.resourceType.quantityScale)
    : null;
  const listingPriceResult = listingWallet
    ? previewAmount(listingPrice, listingWallet.minorUnitScale)
    : null;
  const listingQuantityFits =
    listingInventory && listingQuantityResult?.ok
      ? quantityFitsAvailable(
          listingQuantityResult.canonical,
          listingInventory.availableQuantity,
          listingInventory.resourceType.quantityScale,
        )
      : false;
  const expiryIsFuture = summary ? isTickInFuture(listingExpiry, summary.currentTick) : false;
  const blockReason = commerceActionBlockReason(summary, projection, reconciliation);
  const refreshAfterAccepted = useCallback(async () => {
    setSelectedListingId('');
    setQuantity('');
    setPreview(null);
    setConfirmed(false);
    setWalletId('');
    setInventoryId('');
    setListingInventoryId('');
    setListingWalletId('');
    setListingQuantity('');
    setListingPrice('');
    setListingExpiry('');
    setCancellationListingId('');
    setCancellationConfirmed(false);
    await onAccepted();
  }, [onAccepted]);
  const command = useEconomyCommand({
    onAccepted: refreshAfterAccepted,
    returnPath: `/worlds/${worldId}/economy/market`,
    summary,
    worldId,
  });

  useEffect(() => {
    setPreview(null);
    setPreviewError('');
    setConfirmed(false);
  }, [quantity, selectedListingId]);

  useEffect(() => {
    if (cancellationListing) cancellationHeadingRef.current?.focus();
  }, [cancellationListing]);

  async function quote() {
    if (!selected || !quantity) return;
    const quantityResult = exactPositiveQuantity(quantity, selected.resourceType.quantityScale);
    if (!quantityResult.ok) {
      setPreviewError(quantityResult.message);
      return;
    }
    setPreviewLoading(true);
    setPreviewError('');
    try {
      const response = await requestJson<{ preview: PurchasePreview }>(
        `/api/v1/worlds/${worldId}/economy/market/listings/${selected.id}/purchase-preview?quantity=${encodeURIComponent(quantityResult.canonical)}`,
      );
      setPreview(response.preview);
    } catch (cause) {
      setPreviewError(failureMessage(cause));
    } finally {
      setPreviewLoading(false);
    }
  }

  function purchase() {
    if (!preview || !wallet || !selected || !reconciliation || blockReason) return;
    void command.submit(
      'PurchaseMarketListingV1',
      {
        buyerInventoryId: inventory?.id ?? null,
        buyerWalletId: wallet.wallet.id,
        expectedBuyerInventoryVersion: inventory?.rowVersion ?? null,
        expectedBuyerWalletVersion: wallet.balance.rowVersion,
        expectedListingVersion: preview.listingVersion,
        listingId: selected.id,
        quantity: preview.quantity,
      },
      reconciliation.expansionVersion,
    );
  }

  function createListing(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      !listingInventory ||
      !listingWallet ||
      !listingQuantityResult?.ok ||
      !listingQuantityFits ||
      !listingPriceResult?.ok ||
      !expiryIsFuture ||
      !reconciliation ||
      blockReason
    ) {
      return;
    }
    void command.submit(
      'CreateMarketListingV1',
      {
        expiresAtTick: listingExpiry,
        expectedInventoryVersion: listingInventory.rowVersion,
        quantity: listingQuantityResult.canonical,
        sellerInventoryId: listingInventory.id,
        sellerWalletId: listingWallet.wallet.id,
        unitPriceMinor: listingPriceResult.value.minor,
      },
      reconciliation.expansionVersion,
    );
  }

  function cancelListing() {
    if (!cancellationListing || !reconciliation || !cancellationConfirmed || blockReason) return;
    void command.submit(
      'CancelMarketListingV1',
      {
        expectedListingVersion: cancellationListing.rowVersion,
        listingId: cancellationListing.id,
      },
      reconciliation.expansionVersion,
    );
  }

  const controlledListingInventories = data.inventories.filter(
    (item) => item.controlledByActor && /[1-9]/u.test(item.availableQuantity),
  );
  return (
    <div className="commerce-stack">
      <CommandFeedback check={command.check} retry={command.retry} state={command.state} />
      <section aria-labelledby="create-listing-heading" className="card">
        <p className="eyebrow">Exact quantity and fixed virtual price</p>
        <h2 id="create-listing-heading">Create a fixed-price listing</h2>
        {controlledListingInventories.length === 0 ? (
          <EmptyState text="No controlled inventory has an available quantity that can be listed." />
        ) : (
          <form className="form-stack" onSubmit={createListing}>
            <label>
              Controlled seller inventory
              <select
                onChange={(event) => {
                  setListingInventoryId(event.currentTarget.value);
                  setListingWalletId('');
                  setListingQuantity('');
                }}
                required
                value={listingInventoryId}
              >
                <option value="">Choose available inventory</option>
                {controlledListingInventories.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.resourceType.displayName} ·{' '}
                    {formatExactQuantity(item.availableQuantity, item.resourceType.unitCode)}{' '}
                    available · {item.ownerEntityKey}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Active seller wallet with the same owner
              <select
                disabled={!listingInventory}
                onChange={(event) => setListingWalletId(event.currentTarget.value)}
                required
                value={listingWalletId}
              >
                <option value="">Choose a matching wallet</option>
                {sellerWallets.map((item) => (
                  <option key={item.wallet.id} value={item.wallet.id}>
                    {item.currencyCode} · {item.wallet.ownerEntityLogicalKey} · available{' '}
                    {formatMinor(item.balance.availableMinor, item.minorUnitScale)}
                  </option>
                ))}
              </select>
            </label>
            <div className="economy-two-fields">
              <label>
                Exact quantity
                <input
                  inputMode="decimal"
                  onChange={(event) => setListingQuantity(event.currentTarget.value.trim())}
                  placeholder={listingInventory?.resourceType.quantityScale === 0 ? '10' : '10.00'}
                  required
                  value={listingQuantity}
                />
              </label>
              <label>
                Unit price in {listingWallet?.currencyCode ?? 'selected virtual currency'}
                <input
                  inputMode="decimal"
                  onChange={(event) => setListingPrice(event.currentTarget.value.trim())}
                  placeholder={listingWallet?.minorUnitScale === 0 ? '4' : '4.00'}
                  required
                  value={listingPrice}
                />
              </label>
            </div>
            <label>
              Expires at authoritative world tick
              <input
                inputMode="numeric"
                onChange={(event) => setListingExpiry(event.currentTarget.value.trim())}
                pattern="(?:0|[1-9][0-9]*)"
                required
                value={listingExpiry}
              />
            </label>
            <div aria-live="polite" className="amount-preview">
              <strong>Current tick {summary?.currentTick ?? 'unavailable'} · no cash value</strong>
              {listingInventory && listingQuantityResult?.ok ? (
                listingQuantityFits ? (
                  <span>
                    Reserved if accepted:{' '}
                    {formatExactQuantity(
                      listingQuantityResult.canonical,
                      listingInventory.resourceType.unitCode,
                    )}
                  </span>
                ) : (
                  <span className="danger-text">
                    Quantity exceeds the displayed authoritative available inventory.
                  </span>
                )
              ) : listingQuantity && listingQuantityResult && !listingQuantityResult.ok ? (
                <span className="danger-text">{listingQuantityResult.message}</span>
              ) : (
                <span>Choose inventory and enter its exact quantity.</span>
              )}
              {listingWallet && listingPriceResult?.ok ? (
                <span>
                  Exact unit price: {listingPriceResult.value.canonical}{' '}
                  {listingWallet.currencyCode} ({listingPriceResult.value.minor} minor units)
                </span>
              ) : listingPrice && listingPriceResult && !listingPriceResult.ok ? (
                <span className="danger-text">{listingPriceResult.message}</span>
              ) : (
                <span>Choose a wallet and enter an exact virtual unit price.</span>
              )}
              {listingExpiry && !expiryIsFuture ? (
                <span className="danger-text">Expiry must be later than the current tick.</span>
              ) : null}
            </div>
            {blockReason ? (
              <p className="danger-text" role="status">
                {blockReason}
              </p>
            ) : null}
            <p className="field-help">
              Acceptance reserves exactly this inventory until fill, cancellation, or expiry. It
              does not create a deposit, withdrawal, cash value, or investment claim.
            </p>
            <button
              className="button"
              disabled={
                command.pending ||
                Boolean(blockReason) ||
                !listingInventory ||
                !listingWallet ||
                !listingQuantityResult?.ok ||
                !listingQuantityFits ||
                !listingPriceResult?.ok ||
                !expiryIsFuture
              }
              type="submit"
            >
              Reserve inventory and create listing
            </button>
          </form>
        )}
      </section>
      <section aria-labelledby="market-heading" className="card">
        <p className="eyebrow">Open, reserved listings</p>
        <h2 id="market-heading">Fixed-price marketplace</h2>
        {data.listings.length === 0 ? (
          <EmptyState text="No open fixed-price listings are available." />
        ) : (
          <div className="commerce-card-grid">
            {data.listings.map((listing) => (
              <article className="commerce-record" key={listing.id}>
                <div className="commerce-record-heading">
                  <h3>{listing.resourceType.displayName}</h3>
                  <StatusBadge status={listing.status} />
                </div>
                <p>
                  {formatExactQuantity(listing.remainingQuantity, listing.resourceType.unitCode)}{' '}
                  remaining
                </p>
                <p>{listing.unitPriceMinor} minor units per exact unit</p>
                <p>Expires at authoritative tick {listing.expiresAtTick}</p>
                <div className="economy-inline-actions">
                  <button
                    aria-pressed={selectedListingId === listing.id}
                    className="button secondary"
                    onClick={() => setSelectedListingId(listing.id)}
                    type="button"
                  >
                    Review purchase
                  </button>
                  {listing.canCancel ? (
                    <button
                      className="text-button danger-text"
                      disabled={command.pending || Boolean(blockReason)}
                      onClick={() => {
                        setCancellationListingId(listing.id);
                        setCancellationConfirmed(false);
                      }}
                      type="button"
                    >
                      Review listing cancellation
                    </button>
                  ) : null}
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      {cancellationListing ? (
        <section
          aria-labelledby="cancel-listing-heading"
          className="card atomic-purchase-card"
          role="dialog"
        >
          <p className="eyebrow">Terminal reservation release</p>
          <h2 id="cancel-listing-heading" ref={cancellationHeadingRef} tabIndex={-1}>
            Confirm listing cancellation
          </h2>
          <p>
            Cancelling releases the authoritative reservation for{' '}
            {formatExactQuantity(
              cancellationListing.remainingQuantity,
              cancellationListing.resourceType.unitCode,
            )}{' '}
            and makes this listing terminal. Completed partial trades remain immutable.
          </p>
          <label className="checkbox-row atomic-confirmation">
            <input
              checked={cancellationConfirmed}
              onChange={(event) => setCancellationConfirmed(event.currentTarget.checked)}
              type="checkbox"
            />
            I understand this action permanently closes the listing and releases only its remaining
            reserved quantity.
          </label>
          <div className="economy-inline-actions">
            <button
              className="button danger-button"
              disabled={command.pending || !cancellationConfirmed || Boolean(blockReason)}
              onClick={cancelListing}
              type="button"
            >
              Cancel listing and release reservation
            </button>
            <button
              className="button secondary"
              onClick={() => {
                setCancellationListingId('');
                setCancellationConfirmed(false);
              }}
              type="button"
            >
              Keep listing open
            </button>
          </div>
        </section>
      ) : null}

      {selected ? (
        <section aria-labelledby="purchase-heading" className="card atomic-purchase-card">
          <p className="eyebrow">Atomic settlement confirmation</p>
          <h2 id="purchase-heading">Purchase {selected.resourceType.displayName}</h2>
          <div className="form-stack">
            <label>
              Exact quantity ({selected.resourceType.unitCode}, up to{' '}
              {selected.resourceType.quantityScale} decimals)
              <input
                inputMode="decimal"
                onChange={(event) => setQuantity(event.currentTarget.value.trim())}
                value={quantity}
              />
            </label>
            <button
              className="button secondary"
              disabled={!quantity || previewLoading}
              onClick={() => void quote()}
              type="button"
            >
              {previewLoading ? 'Calculating authoritative quote…' : 'Preview exact total'}
            </button>
            {previewError ? (
              <p className="danger-text" role="alert">
                {previewError}
              </p>
            ) : null}
            {preview ? (
              <div aria-live="polite" className="purchase-confirmation">
                <h3>Server-authoritative itemization</h3>
                <dl className="economy-facts">
                  {purchaseConfirmationRows(preview).map(([label, value]) => (
                    <div key={label}>
                      <dt>{label}</dt>
                      <dd>{value}</dd>
                    </div>
                  ))}
                </dl>
                <p>
                  Quantity: {formatExactQuantity(preview.quantity, selected.resourceType.unitCode)}
                </p>
              </div>
            ) : null}
            <label>
              Controlled buyer wallet
              <select onChange={(event) => setWalletId(event.currentTarget.value)} value={walletId}>
                <option value="">Choose a wallet</option>
                {wallets
                  .filter((item) => item.wallet.currencyId === selected.currencyId)
                  .map((item) => (
                    <option key={item.wallet.id} value={item.wallet.id}>
                      {item.wallet.ownerEntityLogicalKey} · {item.balance.availableMinor} minor
                      units
                    </option>
                  ))}
              </select>
            </label>
            <label>
              Destination inventory (optional; the server can create the exact resource inventory)
              <select
                onChange={(event) => setInventoryId(event.currentTarget.value)}
                value={inventoryId}
              >
                <option value="">Create or select server-side</option>
                {matchingInventories.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.ownerEntityKey} · version {item.rowVersion}
                  </option>
                ))}
              </select>
            </label>
            <label className="checkbox-row atomic-confirmation">
              <input
                checked={confirmed}
                onChange={(event) => setConfirmed(event.currentTarget.checked)}
                type="checkbox"
              />
              I reviewed the exact quantity, subtotal, tax, marketplace fee, total, wallet, and
              destination above. The server will recheck every version atomically.
            </label>
            {blockReason ? (
              <p className="danger-text" role="status">
                {blockReason}
              </p>
            ) : null}
            <button
              className="button"
              disabled={
                command.pending || !preview || !wallet || !confirmed || Boolean(blockReason)
              }
              onClick={purchase}
              type="button"
            >
              Purchase with one atomic settlement
            </button>
          </div>
        </section>
      ) : null}

      <section aria-labelledby="trades-heading" className="card">
        <h2 id="trades-heading">Immutable trade outcomes</h2>
        {data.trades.length === 0 ? (
          <EmptyState text="No completed market trades are visible yet." />
        ) : (
          <ul className="commerce-list">
            {data.trades.map((trade) => (
              <li key={trade.id}>
                <span>
                  <strong>
                    {trade.quantity} units at tick {trade.createdTick}
                  </strong>
                  <small>
                    Gross {trade.grossMinor} · tax {trade.taxMinor} · fee {trade.feeMinor}
                  </small>
                </span>
                <span>{trade.buyerTotalMinor} total minor units</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function TreasuryPanel({
  data,
  reconciliation,
  treasury,
}: {
  data: CommerceData;
  reconciliation: ReconciliationSummary | null;
  treasury: TreasuryView | null;
}) {
  return (
    <div className="commerce-stack">
      <section aria-labelledby="treasury-heading" className="card">
        <p className="eyebrow">No cash value</p>
        <h2 id="treasury-heading">Treasury & collected revenue</h2>
        {treasury ? (
          <dl className="economy-facts commerce-treasury-facts">
            <div>
              <dt>Virtual balance</dt>
              <dd>{treasury.balanceMinor} minor units</dd>
            </div>
            <div>
              <dt>Recorded revenue</dt>
              <dd>{treasury.revenueMinor} minor units</dd>
            </div>
            <div>
              <dt>Last revenue tick</dt>
              <dd>{treasury.lastRevenueTick ?? 'No revenue recorded'}</dd>
            </div>
          </dl>
        ) : (
          <EmptyState text="No active treasury wallet is available." />
        )}
      </section>
      <section aria-labelledby="reconciliation-heading" className="card">
        <h2 id="reconciliation-heading">Expansion reconciliation</h2>
        {reconciliation ? (
          <>
            <dl className="economy-facts">
              <div>
                <dt>Expansion version</dt>
                <dd>{reconciliation.expansionVersion}</dd>
              </div>
              <div>
                <dt>Last result</dt>
                <dd>{reconciliation.lastRun?.status ?? 'Not run'}</dd>
              </div>
              <div>
                <dt>Mismatches</dt>
                <dd>{reconciliation.lastRun?.mismatchCount ?? 'Pending'}</dd>
              </div>
              <div>
                <dt>Projection checksum</dt>
                <dd>
                  <code>{reconciliation.projectionChecksum}</code>
                </dd>
              </div>
            </dl>
            {reconciliation.lastRun?.status === 'mismatch' ? (
              <p className="danger-text" role="alert">
                Reconciliation found a conflict. Mutations remain server-blocked; append-only repair
                requires separately authorized operator review.
              </p>
            ) : null}
          </>
        ) : (
          <EmptyState text="No commerce reconciliation checkpoint is available." />
        )}
      </section>
      <section aria-labelledby="tax-heading" className="card">
        <h2 id="tax-heading">Tax assessments</h2>
        {data.taxAssessments.length === 0 ? (
          <EmptyState text="No tax assessments have been recorded." />
        ) : (
          <ul className="commerce-list">
            {data.taxAssessments.map((assessment) => (
              <li key={assessment.id}>
                <span>
                  <strong>{assessment.sourceType.replaceAll('_', ' ')}</strong>
                  <small>
                    Tick {assessment.tick} · basis {assessment.basisMinor}
                  </small>
                </span>
                <span>{assessment.amountMinor} minor units</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
