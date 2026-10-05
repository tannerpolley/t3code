import type { RepositoryIdentity } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { threadPullRequestLabel } from "./threadPullRequestLabel";

const forkCheckout: RepositoryIdentity = {
  canonicalKey: "github.com/pingdotgg/t3code",
  locator: {
    source: "git-remote",
    remoteName: "upstream",
    remoteUrl: "https://github.com/pingdotgg/t3code.git",
  },
  provider: "github",
  owner: "pingdotgg",
  name: "t3code",
  originRepository: "tannerpolley/t3code",
};

describe("threadPullRequestLabel", () => {
  it("names a pull request from another repository by that repository", () => {
    expect(
      threadPullRequestLabel({ repository: "agentic-cse/cse-plugin", number: 125 }, forkCheckout),
    ).toBe("agentic-cse/cse-plugin#125");
  });

  it("keeps the short number for the thread's repository and the fork it pushes from", () => {
    expect(
      threadPullRequestLabel({ repository: "PingDotGG/t3code", number: 7 }, forkCheckout),
    ).toBe("#7");
    expect(
      threadPullRequestLabel({ repository: "tannerpolley/t3code", number: 8 }, forkCheckout),
    ).toBe("#8");
    expect(threadPullRequestLabel({ number: 9 }, forkCheckout)).toBe("#9");
  });
});
