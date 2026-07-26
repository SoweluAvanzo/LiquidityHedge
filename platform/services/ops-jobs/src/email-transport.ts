/**
 * Resend transport for the data export. Thin by design: the report is
 * built and validated elsewhere, this only ships it.
 *
 * Requires RESEND_API_KEY. `from` must be an address on a domain verified
 * in your Resend account (Resend's shared `onboarding@resend.dev` only
 * delivers to the account owner's own address).
 */

import { DataReport } from "./data-report";

export interface SendOptions {
  apiKey: string;
  from: string;
  to: string[];
  fetchImpl?: typeof fetch;
}

export interface SendResult {
  id: string;
  to: string[];
  attachments: number;
}

export async function sendReportViaResend(
  report: DataReport,
  opts: SendOptions,
): Promise<SendResult> {
  if (!opts.apiKey) throw new Error("RESEND_API_KEY is required to send");
  if (opts.to.length === 0) throw new Error("no recipients configured");
  const f = opts.fetchImpl ?? fetch;

  const res = await f("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: opts.from,
      to: opts.to,
      subject: report.subject,
      text: report.text,
      html: report.html,
      attachments: report.attachments.map((a) => ({
        filename: a.filename,
        content: a.content, // base64 CSV
      })),
    }),
  });

  const body = (await res.json().catch(() => ({}))) as {
    id?: string;
    message?: string;
    name?: string;
  };
  if (!res.ok) {
    throw new Error(
      `Resend ${res.status}: ${body.message ?? body.name ?? "unknown error"}`,
    );
  }
  return {
    id: body.id ?? "(no id)",
    to: opts.to,
    attachments: report.attachments.length,
  };
}
