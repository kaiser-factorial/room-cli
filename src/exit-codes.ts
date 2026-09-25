/**
 * Decade exit codes, per the ledger house style. Higher decade = worse.
 */
export const EXIT = {
  OK: 0,
  CONFIG: 10,
  SEAT_START: 20,
  AUTH: 30,
  PROTOCOL: 40,
  PERMISSIONS: 50,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export function worst(codes: ExitCode[]): ExitCode {
  return codes.reduce<ExitCode>((a, b) => (b > a ? b : a), EXIT.OK);
}
