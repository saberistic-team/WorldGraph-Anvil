import Link from 'next/link';

import type { SystemInfo } from '@worldgraph/contracts';

import { callApi } from './lib/api';

async function apiBuild(): Promise<string> {
  try {
    const response = await callApi('/api/v1/system/info');
    if (!response.ok) return 'unavailable';
    const info = (await response.json()) as SystemInfo;
    return info.build.api;
  } catch {
    return 'unavailable';
  }
}

export default async function Home() {
  const webBuild = process.env.BUILD_REVISION ?? 'local-dev';
  const apiRevision = await apiBuild();

  return (
    <main id="main-content">
      <header className="hero shell">
        <p className="eyebrow">WorldGraph / Anvil</p>
        <h1>Build a society, not just a scene.</h1>
        <p className="lede">
          WorldGraph will turn an approved, versioned design into an authoritative city-state that
          can be played, governed, audited, and evolved. This foundation deliberately begins with
          trustworthy state—not generated 3D decoration.
        </p>
        <div className="actions">
          <Link className="button" href="/register">
            Create alpha account
          </Link>
          <Link className="button secondary" href="/sign-in">
            Sign in
          </Link>
          <Link className="text-link" href="/system">
            View system status
          </Link>
          <Link className="text-link" href="/primitives">
            Browse primitives
          </Link>
          <a className="text-link" href="#mvp-boundary">
            Read the MVP boundary
          </a>
        </div>
      </header>

      <section className="section shell" id="mvp-boundary" aria-labelledby="boundary-heading">
        <div>
          <p className="eyebrow">Closed-alpha boundary</p>
          <h2 id="boundary-heading">One persistent multiplayer city-state</h2>
        </div>
        <div className="card-grid">
          <article className="card">
            <h3>Authoritative first</h3>
            <p>
              Ownership, balances, laws, and simulation will live on the server and remain testable
              without a renderer.
            </p>
          </article>
          <article className="card">
            <h3>AI proposes</h3>
            <p>
              Generated content will be constrained, validated, previewed, and approved before any
              authoritative change.
            </p>
          </article>
          <article className="card">
            <h3>Fictional economy</h3>
            <p>
              The MVP currency is closed-loop only: no purchase, redemption, cash-out, blockchain,
              or real-money claim.
            </p>
          </article>
        </div>
      </section>

      <footer className="footer shell">
        <span>Web build: {webBuild}</span>
        <span>API build: {apiRevision}</span>
        <span>Compatibility schema: 3</span>
      </footer>
    </main>
  );
}
