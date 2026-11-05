// The home page's "race vs ballot" model. Expected values, not a measurement: it shows what each way of selling does to the
// units when one operator brings many PayPal accounts. Bots win a race by definition, so a race gives them every unit they
// can reach. In a ballot each ticket is equally likely, so the expected share is tickets / all tickets.

/** Pairwise recall of Paylet's review on the blind held-out set (docs/EVALS.md): links it misses keep their own ticket. */
export const MEASURED_RECALL = 0.833;

export interface RaceInput {
  units: number;
  fans: number;
  scalperAccounts: number;
  recall?: number;
}

export interface RaceResult {
  /** units expected to reach real fans under each way of selling */
  race: number;
  ballot: number;
  paylet: number;
}

const round1 = (x: number) => Math.round(x * 10) / 10;

export function raceVsBallot({ units, fans, scalperAccounts: a, recall = MEASURED_RECALL }: RaceInput): RaceResult {
  const toFans = (scalperTickets: number) => (fans === 0 ? 0 : units * (fans / (fans + scalperTickets)));
  const missed = a * (1 - recall); // accounts the review doesn't link keep separate tickets
  return { race: round1(Math.max(0, units - a)), ballot: round1(toFans(a)), paylet: round1(toFans(a === 0 ? 0 : 1 + missed)) };
}
