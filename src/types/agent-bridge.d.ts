declare module "@cwdcwd/agent-bridge" {
  export interface A2AClientOptions {
    endpoint: string;
    token?: string;
    timeoutMs?: number;
  }

  export class A2AClient {
    constructor(options: A2AClientOptions);
    notify(
      event: string,
      payload: Record<string, unknown>,
      sender?: string,
    ): Promise<void>;
    sendMessage(text: string, sender?: string): Promise<void>;
  }

  export class AgentBridge {
    constructor(options: Record<string, unknown>);
  }

  export class GitHubClient {
    constructor(options: Record<string, unknown>);
  }
}