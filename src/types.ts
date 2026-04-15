export interface Credentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export interface AnthropicMessage {
  role: string;
  content: string | Array<Record<string, unknown>>;
}
