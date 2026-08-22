import nodemailer from "nodemailer";

export interface Mailer {
  sendOtp(email: string, code: string): Promise<void>;
  sendContactRequest?(email: string, requesterNickname: string): Promise<void>;
  sendContactAccepted?(email: string, nickname: string): Promise<void>;
}

export class MemoryMailer implements Mailer {
  readonly messages: Array<{ to: string; code: string }> = [];
  readonly notifications: Array<{
    to: string;
    type: "contact_request" | "contact_accepted";
    nickname: string;
  }> = [];

  async sendOtp(email: string, code: string) {
    this.messages.push({ to: email, code });
  }

  lastCodeFor(email: string) {
    return this.messages.findLast((message) => message.to === email)?.code;
  }

  async sendContactRequest(email: string, requesterNickname: string) {
    this.notifications.push({
      to: email,
      type: "contact_request",
      nickname: requesterNickname,
    });
  }

  async sendContactAccepted(email: string, nickname: string) {
    this.notifications.push({
      to: email,
      type: "contact_accepted",
      nickname,
    });
  }
}

export class ConsoleMailer implements Mailer {
  async sendOtp(email: string, code: string) {
    console.info(`[OnlyLove] ${email} 验证码：${code}`);
  }

  async sendContactRequest(email: string, requesterNickname: string) {
    console.info(`[OnlyLove] ${email} 收到来自 ${requesterNickname} 的联系请求`);
  }

  async sendContactAccepted(email: string, nickname: string) {
    console.info(`[OnlyLove] ${email} 已与 ${nickname} 建立联系`);
  }
}

export class SmtpMailer implements Mailer {
  private readonly transport;

  constructor(
    options: {
      host: string;
      port: number;
      user: string;
      password: string;
    },
    private readonly from: string,
  ) {
    this.transport = nodemailer.createTransport({
      host: options.host,
      port: options.port,
      secure: options.port === 465,
      auth: { user: options.user, pass: options.password },
    });
  }

  async sendOtp(email: string, code: string) {
    await this.transport.sendMail({
      from: this.from,
      to: email,
      subject: "OnlyLove 邮箱验证码",
      text: `你的 OnlyLove 验证码是 ${code}，十分钟内有效。`,
    });
  }

  async sendContactRequest(email: string, requesterNickname: string) {
    await this.transport.sendMail({
      from: this.from,
      to: email,
      subject: "OnlyLove 新的联系请求",
      text: `${requesterNickname} 希望与你进一步了解。登录 OnlyLove 查看候选卡并处理请求。`,
    });
  }

  async sendContactAccepted(email: string, nickname: string) {
    await this.transport.sendMail({
      from: this.from,
      to: email,
      subject: "OnlyLove 已建立联系",
      text: `你已与 ${nickname} 建立联系，可以在 OnlyLove 开始真人交流。`,
    });
  }
}

export function createMailer(env: Record<string, string | undefined>): Mailer {
  if (env.NODE_ENV === "test") return new MemoryMailer();
  if (env.NODE_ENV !== "production") return new ConsoleMailer();

  const required = [
    "SMTP_HOST",
    "SMTP_PORT",
    "SMTP_USER",
    "SMTP_PASSWORD",
    "SMTP_FROM",
  ] as const;
  for (const name of required) {
    if (!env[name]) throw new Error(`${name} is required in production`);
  }
  const port = Number(env.SMTP_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("SMTP_PORT must be a valid port");
  }
  return new SmtpMailer(
    {
      host: env.SMTP_HOST!,
      port,
      user: env.SMTP_USER!,
      password: env.SMTP_PASSWORD!,
    },
    env.SMTP_FROM!,
  );
}
