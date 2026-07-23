import Link from 'next/link';

import { SystemStatus } from './system-status';

export default function SystemPage() {
  return (
    <main className="shell system-page" id="main-content">
      <nav aria-label="Breadcrumb">
        <Link className="text-link" href="/">
          WorldGraph home
        </Link>
      </nav>
      <header>
        <p className="eyebrow">Operational status</p>
        <h1>System readiness</h1>
        <p className="lede compact">
          Liveness means the API can respond. Readiness also requires compatible storage, Redis, and
          a current worker heartbeat.
        </p>
      </header>
      <SystemStatus />
    </main>
  );
}
