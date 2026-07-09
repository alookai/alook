"use client";


import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";

const PROVIDERS = [
  {
    id: "gmail",
    name: "Gmail",
    imap: { host: "imap.gmail.com", port: 993 },
    smtp: { host: "smtp.gmail.com", port: 587 },
    steps: [
      "Enable 2-Step Verification in your Google Account (Security > 2-Step Verification).",
      "Go to https://myaccount.google.com/apppasswords and generate an App Password.",
      'Enter a name (e.g. "Alook") and click Generate.',
      "Copy the 16-character password — use this as both IMAP and SMTP password.",
      "Username is your full Gmail address (e.g. you@gmail.com).",
    ],
    note: "Gmail no longer supports regular passwords for third-party apps. You must use an App Password.",
  },
  {
    id: "outlook",
    name: "Outlook",
    imap: { host: "outlook.office365.com", port: 993 },
    smtp: { host: "smtp.office365.com", port: 587 },
    steps: [
      "Sign in at https://account.microsoft.com/security.",
      "Go to Security > Advanced Security Options > App Passwords.",
      "Generate an App Password and use it as both IMAP and SMTP password.",
      "Username is your full email address (e.g. you@outlook.com).",
    ],
    note: "If your organization uses Microsoft 365, your admin may need to enable App Passwords or IMAP access.",
  },
  {
    id: "yahoo",
    name: "Yahoo",
    imap: { host: "imap.mail.yahoo.com", port: 993 },
    smtp: { host: "smtp.mail.yahoo.com", port: 587 },
    steps: [
      "Go to https://login.yahoo.com/account/security.",
      'Enable "Allow apps that use less secure sign in" or generate an App Password.',
      "Use the App Password as both IMAP and SMTP password.",
      "Username is your full Yahoo email address.",
    ],
    note: null,
  },
  {
    id: "icloud",
    name: "iCloud",
    imap: { host: "imap.mail.me.com", port: 993 },
    smtp: { host: "smtp.mail.me.com", port: 587 },
    steps: [
      "Go to https://appleid.apple.com and sign in.",
      "Navigate to Sign-In and Security > App-Specific Passwords.",
      "Generate an App-Specific Password.",
      "Use the generated password as both IMAP and SMTP password.",
      "Username is your full iCloud email address (e.g. you@icloud.com).",
    ],
    note: "Two-factor authentication must be enabled on your Apple ID.",
  },
  {
    id: "qq",
    name: "QQ",
    imap: { host: "imap.qq.com", port: 993 },
    smtp: { host: "smtp.qq.com", port: 587 },
    steps: [
      "Log in to QQ Mail (mail.qq.com).",
      "Go to Settings > Account > POP3/IMAP/SMTP/Exchange/CardDAV.",
      "Enable IMAP/SMTP service — you may need to send an SMS to verify.",
      "After verification, QQ Mail will display an authorization code.",
      "Use the authorization code as both IMAP and SMTP password (not your QQ password).",
      "Username is your full QQ email address (e.g. 123456789@qq.com).",
    ],
    note: null,
  },
  {
    id: "163",
    name: "163",
    imap: { host: "imap.163.com", port: 993 },
    smtp: { host: "smtp.163.com", port: 465 },
    steps: [
      "Log in to 163 Mail (mail.163.com).",
      "Go to Settings > POP3/SMTP/IMAP.",
      "Enable IMAP/SMTP service and set an authorization password.",
      "Use the authorization password as both IMAP and SMTP password.",
      "Username is your full 163 email address (e.g. you@163.com).",
    ],
    note: "SMTP uses port 465 with SSL instead of the typical 587.",
  },
  {
    id: "feishu",
    name: "Feishu",
    imap: { host: "imap.feishu.cn", port: 993 },
    smtp: { host: "smtp.feishu.cn", port: 465 },
    steps: [
      "Log in to Feishu Admin Console.",
      "Go to Security > Application Password, or ask your admin to enable IMAP/SMTP.",
      "Generate an application-specific password.",
      "Use the application password as both IMAP and SMTP password.",
      "Username is your full Feishu email address.",
    ],
    note: "SMTP uses port 465 with SSL. Your organization admin must enable IMAP access.",
  },
  {
    id: "other",
    name: "Other",
    imap: null,
    smtp: null,
    steps: [
      "Check your email provider's help docs for IMAP/SMTP server settings.",
      "IMAP is typically on port 993 (SSL/TLS), SMTP on port 587 (STARTTLS) or 465 (SSL).",
      "If your provider supports App Passwords, generate one and use it instead of your account password.",
      "Username is usually your full email address.",
    ],
    note: null,
  },
];

export default function EmailSetupHelpPage() {
  return (
    <>
      <div className="flex items-center justify-between border-b border-border/50 px-3 sm:px-4 py-2 gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <h1 className="text-sm font-medium">Email Setup Guide</h1>
          <p className="text-xs text-muted-foreground hidden sm:block">
            How to get IMAP/SMTP credentials for your email provider
          </p>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-6">
        <div className="mx-auto max-w-2xl">
          <Tabs defaultValue="gmail">
            <TabsList className="flex-wrap h-auto gap-1">
              {PROVIDERS.map((p) => (
                <TabsTrigger key={p.id} value={p.id}>
                  {p.name}
                </TabsTrigger>
              ))}
            </TabsList>

            {PROVIDERS.map((provider) => (
              <TabsContent key={provider.id} value={provider.id} className="space-y-4 pt-4">
                {provider.imap && provider.smtp && (
                  <div className="grid grid-cols-2 gap-3 text-xs">
                    <div className="rounded-md border border-border/50 px-3 py-2 space-y-1">
                      <span className="font-medium text-muted-foreground">IMAP</span>
                      <div className="font-mono">{provider.imap.host}:{provider.imap.port}</div>
                    </div>
                    <div className="rounded-md border border-border/50 px-3 py-2 space-y-1">
                      <span className="font-medium text-muted-foreground">SMTP</span>
                      <div className="font-mono">{provider.smtp.host}:{provider.smtp.port}</div>
                    </div>
                  </div>
                )}

                <ol className="list-decimal list-inside space-y-2 text-sm text-muted-foreground">
                  {provider.steps.map((step, i) => (
                    <li key={i}>{step}</li>
                  ))}
                </ol>

                {provider.note && (
                  <p className="text-xs text-amber-600 dark:text-amber-400 rounded-md bg-amber-500/5 border border-amber-500/10 px-3 py-2">
                    {provider.note}
                  </p>
                )}
              </TabsContent>
            ))}
          </Tabs>
        </div>
      </div>
    </>
  );
}
