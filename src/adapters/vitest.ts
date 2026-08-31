export type { CassetteClient, ReplayContext } from "../core/client.js";
export type { TestCassetteOptions } from "./testing.js";

import type { CassetteClient } from "../core/client.js";
import { withTestCassette, type TestCassetteOptions } from "./testing.js";

export function withVitestCassette<Request, Response>(
  options: TestCassetteOptions<Request, Response>,
): Promise<CassetteClient<Request, Response>> {
  return withTestCassette("vitest", options);
}
