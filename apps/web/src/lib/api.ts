import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";

import type { AppClient } from "../../../server/src/index.ts";

export const api: AppClient = createORPCClient(
  new RPCLink({ url: `${window.location.origin}/rpc` }),
);
