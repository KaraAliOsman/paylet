import { useState } from "react";
import { MEASURED_RECALL, raceVsBallot } from "./race-logic";

const UNITS = 10;
const FANS = 300;

/** One bar of ten: each cell is a unit, filled as far as it reaches a real fan. */
function Units({ n }: { n: number }) {
  return (
    <div className="race-units" aria-hidden="true">
      {Array.from({ length: UNITS }, (_, i) => (
        <i key={i}>
          <span style={{ width: `${Math.max(0, Math.min(1, n - i)) * 100}%` }} />
        </i>
      ))}
    </div>
  );
}

export function RaceVsBallot() {
  const [accounts, setAccounts] = useState(40);
  const r = raceVsBallot({ units: UNITS, fans: FANS, scalperAccounts: accounts });
  const rows = [
    { title: "First come, first served", text: "Bots are faster than people, so a race hands them every unit they can reach.", n: r.race },
    { title: "One entry per account", text: "A fair lottery, until one operator brings a stack of accounts.", n: r.ballot },
    { title: "Paylet", text: "One hold per PayPal account, and the accounts behind one forwarder share a ticket once the seller confirms.", n: r.paylet, cls: "is-paylet" },
  ];
  return (
    <section className="race" aria-labelledby="race-title">
      <div className="race-copy">
        <h2 id="race-title">A race rewards the fastest bot.</h2>
        <p>Ten mugs, three hundred real fans, and one reseller. Move the slider to give that reseller more PayPal accounts.</p>
        <p>The FTC alleges one broker used 1,300 accounts on a single concert.</p>
      </div>
      <div className="race-panel">
        <div className="race-control">
          <label htmlFor="race-accounts">
            Accounts held by one reseller <output htmlFor="race-accounts">{accounts}</output>
          </label>
          <input id="race-accounts" type="range" min={1} max={1300} step={1} value={accounts} onChange={(e) => setAccounts(Number(e.target.value))} />
        </div>
        {rows.map((x) => (
          <article key={x.title} className={`race-row ${x.cls ?? ""}`}>
            <header>
              <h3>{x.title}</h3>
              <b>
                {x.n} of {UNITS} reach fans
              </b>
            </header>
            <Units n={x.n} />
            <p>{x.text}</p>
          </article>
        ))}
        <p className="race-note">
          A model of expected units, not a measurement. It assumes the reseller's bots win every race and that the review links {Math.round(MEASURED_RECALL * 100)}% of their accounts, its
          recall on our blind test set. Accounts it misses keep their own tickets.
        </p>
      </div>
    </section>
  );
}
