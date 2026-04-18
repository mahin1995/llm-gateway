import { FormEvent, useEffect, useMemo, useState } from "react";
import type { ReactElement } from "react";
import { apiDelete, apiGet, apiPatch, apiPost, apiPostPublic, type ChatMessage } from "./api.js";

type RoutePath = "/dashboard" | "/admin" | "/api-keys" | "/openrouter-keys" | "/openrouter-models" | "/tester" | "/logs" | "/policy";

interface UserSummary {
  id: string;
  email: string;
  name: string;
  isAdmin: boolean;
  status: string;
}

interface ApiKeyRecord {
  id: string;
  name: string;
  status: string;
  lastUsedAt: string | null;
  createdAt: string;
}

interface RequestLog {
  id: string;
  status: string;
  selectedTier: string | null;
  selectedModel: string | null;
  promptPreview: string | null;
  inputTokensEstimated: number;
  outputTokensLimit: number;
  providerInputTokens: number | null;
  providerOutputTokens: number | null;
  providerTotalTokens: number | null;
  providerCost: string | number | null;
  escalationAttempts: number;
  errorCategory: string;
  errorMessage: string | null;
  createdAt: string;
  user?: null | {
    email: string;
    name: string;
  };
}

interface PackageRecord {
  id: string;
  name: string;
  description: string | null;
  maxTier: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxRagTokens: number;
  truncateInput: boolean;
  cacheEnabled: boolean;
  ragEnabled: boolean;
  active: boolean;
  l1ModelId: string;
  l2ModelId: string | null;
  l3ModelId: string | null;
  models: Record<string, string | null>;
  userCount: number;
}

interface PolicyData {
  user: UserSummary;
  policy: {
    maxTier: string;
    maxInputTokens: number;
    maxOutputTokens: number;
    maxRagTokens: number;
    truncateInput: boolean;
    cacheEnabled: boolean;
    ragEnabled: boolean;
    models: Record<string, null | {
      displayName: string;
      modelName: string;
      maxContextTokens: number;
      maxOutputTokens: number;
      provider: {
        name: string;
        active: boolean;
      };
    }>;
  };
}

interface AdminData {
  users: Array<{
    id: string;
    email: string;
    name: string;
    isAdmin: boolean;
    status: string;
    packageId: string | null;
    packageName: string | null;
    policy: null | {
      maxTier: string;
      maxInputTokens: number;
      maxOutputTokens: number;
      maxRagTokens: number;
      cacheEnabled: boolean;
      ragEnabled: boolean;
      models: Record<string, string | null>;
    };
  }>;
  packages: PackageRecord[];
  providers: Array<{
    id: string;
    name: string;
    baseUrl: string;
    apiKeyEnvVar: string;
    active: boolean;
    models: Array<{
      id: string;
      displayName: string;
      modelName: string;
      tier: string;
      active: boolean;
      maxContextTokens: number;
      maxOutputTokens: number;
    }>;
  }>;
  requestLogs: RequestLog[];
}

interface ChatResponse {
  data: {
    content: string;
    selectedTier: string;
    selectedModel: string;
    inputTokensEstimated: number;
    outputTokensLimit: number;
    providerTotalTokens?: number;
    escalationAttempts: number;
  };
}

interface OpenRouterKeySummary {
  byok_usage: number;
  byok_usage_daily: number;
  byok_usage_monthly: number;
  byok_usage_weekly: number;
  created_at: string;
  creator_user_id: string;
  disabled: boolean;
  hash: string;
  include_byok_in_limit: boolean;
  label: string | null;
  limit: number | null;
  limit_remaining: number | null;
  limit_reset: string | null;
  name: string;
  updated_at: string;
  usage: number;
  usage_daily: number;
  usage_monthly: number;
  usage_weekly: number;
  expires_at: string | null;
}

interface OpenRouterModelRecord {
  id: string;
  modelId: string;
  name: string | null;
  description: string | null;
  contextLength: number | null;
  inputCostPer1M: string | null;
  outputCostPer1M: string | null;
  tokenizer: string | null;
  modality: string | null;
  openRouterCreatedAt: string | null;
  syncedAt: string;
  createdAt: string;
  updatedAt: string;
}

type UsageRange = "24h" | "7d" | "30d" | "90d";

interface UsageSummary {
  range: UsageRange;
  from: string;
  to: string;
  totals: {
    cost: number;
    totalTokens: number;
    outputTokens: number;
    requests: number;
  };
  buckets: Array<{
    label: string;
    cost: number;
    totalTokens: number;
    outputTokens: number;
  }>;
}

const defaultPrompt = "Explain the gateway model selection policy in three concise bullets.";
const routePaths: RoutePath[] = ["/dashboard", "/admin", "/api-keys", "/openrouter-keys", "/openrouter-models", "/tester", "/logs", "/policy"];
const emptyPackageForm = {
  name: "Starter",
  description: "Default starter package",
  maxTier: "L2",
  maxInputTokens: 12000,
  maxOutputTokens: 1024,
  maxRagTokens: 0,
  truncateInput: false,
  cacheEnabled: false,
  ragEnabled: false,
  active: true,
  l1ModelId: "",
  l2ModelId: "",
  l3ModelId: ""
};

export function App(): ReactElement {
  const [path, setPath] = usePathname();
  const [sessionToken, setSessionToken] = useState(() => localStorage.getItem("sessionToken") ?? "");
  const [email, setEmail] = useState("admin@example.local");
  const [password, setPassword] = useState("");
  const [user, setUser] = useState<UserSummary | null>(null);
  const [apiKeys, setApiKeys] = useState<ApiKeyRecord[]>([]);
  const [selectedGatewayKey, setSelectedGatewayKey] = useState(() => localStorage.getItem("gatewayApiKey") ?? "");
  const [newKeyName, setNewKeyName] = useState("Codex local key");
  const [createdGatewayKey, setCreatedGatewayKey] = useState("");
  const [policy, setPolicy] = useState<PolicyData | null>(null);
  const [admin, setAdmin] = useState<AdminData | null>(null);
  const [ownLogs, setOwnLogs] = useState<RequestLog[]>([]);
  const [prompt, setPrompt] = useState(defaultPrompt);
  const [requestedTier, setRequestedTier] = useState("");
  const [maxOutputTokens, setMaxOutputTokens] = useState(512);
  const [chatResult, setChatResult] = useState<ChatResponse["data"] | null>(null);
  const [adminUserForm, setAdminUserForm] = useState({
    email: "new-user@example.local",
    name: "New User",
    password: "user12345",
    isAdmin: false,
    packageId: ""
  });
  const [packageForm, setPackageForm] = useState(emptyPackageForm);
  const [selectedPackageId, setSelectedPackageId] = useState("");
  const [modelForm, setModelForm] = useState({
    providerId: "",
    displayName: "Custom L1 Model",
    modelName: "openai/gpt-4o-mini",
    tier: "L1",
    maxContextTokens: 128000,
    maxOutputTokens: 4096,
    active: true
  });
  const [usageRange, setUsageRange] = useState<UsageRange>("7d");
  const [usageSummary, setUsageSummary] = useState<UsageSummary | null>(null);
  const [openRouterKeys, setOpenRouterKeys] = useState<OpenRouterKeySummary[]>([]);
  const [selectedOpenRouterKey, setSelectedOpenRouterKey] = useState<OpenRouterKeySummary | null>(null);
  const [openRouterModels, setOpenRouterModels] = useState<OpenRouterModelRecord[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const logs = admin?.requestLogs ?? ownLogs;
  const activePath = routePaths.includes(path as RoutePath) ? path as RoutePath : "/dashboard";
  const modelOptions = useMemo(() => (admin?.providers ?? []).flatMap((provider) =>
    provider.models.map((model) => ({
      ...model,
      providerName: provider.name
    }))
  ), [admin]);
  const messages = useMemo<ChatMessage[]>(() => [{ role: "user", content: prompt }], [prompt]);

  useEffect(() => {
    localStorage.setItem("sessionToken", sessionToken);
  }, [sessionToken]);

  useEffect(() => {
    localStorage.setItem("gatewayApiKey", selectedGatewayKey);
  }, [selectedGatewayKey]);

  useEffect(() => {
    if (sessionToken && !routePaths.includes(path as RoutePath)) {
      navigateTo("/dashboard", setPath);
    }
  }, [path, sessionToken, setPath]);

  useEffect(() => {
    if (sessionToken) {
      void loadDashboard(sessionToken);
    }
  }, []);

  useEffect(() => {
    if (sessionToken) {
      void loadUsageSummary(sessionToken, usageRange, Boolean(user?.isAdmin));
    }
  }, [usageRange]);

  useEffect(() => {
    if (sessionToken && path === "/openrouter-keys" && user?.isAdmin) {
      void loadOpenRouterKeys();
    }
  }, [path, sessionToken, user?.isAdmin]);

  useEffect(() => {
    if (sessionToken && path === "/openrouter-models" && user?.isAdmin) {
      void loadOpenRouterModels();
    }
  }, [path, sessionToken, user?.isAdmin]);

  async function login(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError("");
    setLoading(true);

    try {
      const response = await apiPostPublic<{ data: { token: string; user: UserSummary } }>("/api/auth/login", {
        email,
        password
      });
      setSessionToken(response.data.token);
      setUser(response.data.user);
      await loadDashboard(response.data.token);
      navigateTo("/dashboard", setPath);
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : "Login failed");
    } finally {
      setLoading(false);
    }
  }

  async function loadDashboard(token = sessionToken): Promise<void> {
    if (!token) return;

    setError("");
    setLoading(true);

    try {
      const [mePayload, policyPayload, keysPayload, logsPayload] = await Promise.all([
        apiGet<{ data: { user: UserSummary } }>("/api/account/me", token),
        apiGet<{ data: PolicyData }>("/api/account/policy", token),
        apiGet<{ data: { apiKeys: ApiKeyRecord[] } }>("/api/account/api-keys", token),
        apiGet<{ data: { requestLogs: RequestLog[] } }>("/api/account/request-logs", token)
      ]);

      setUser(mePayload.data.user);
      setPolicy(policyPayload.data);
      setApiKeys(keysPayload.data.apiKeys);
      setOwnLogs(logsPayload.data.requestLogs);

      if (mePayload.data.user.isAdmin) {
        const [adminPayload, usagePayload] = await Promise.all([
          apiGet<{ data: AdminData }>("/api/admin/dashboard", token),
          apiGet<{ data: UsageSummary }>(`/api/admin/usage-summary?range=${usageRange}`, token)
        ]);
        setAdmin(adminPayload.data);
        setUsageSummary(usagePayload.data);
      } else {
        const usagePayload = await apiGet<{ data: UsageSummary }>(`/api/account/usage-summary?range=${usageRange}`, token);
        setAdmin(null);
        setUsageSummary(usagePayload.data);
        setOpenRouterKeys([]);
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Could not load dashboard");
    } finally {
      setLoading(false);
    }
  }

  async function loadUsageSummary(token: string, range: UsageRange, adminScope: boolean): Promise<void> {
    try {
      const path = adminScope ? "/api/admin/usage-summary" : "/api/account/usage-summary";
      const usagePayload = await apiGet<{ data: UsageSummary }>(`${path}?range=${range}`, token);
      setUsageSummary(usagePayload.data);
    } catch (usageError) {
      setError(usageError instanceof Error ? usageError.message : "Could not load usage summary");
    }
  }

  async function loadOpenRouterKeys(): Promise<void> {
    setError("");
    setLoading(true);

    try {
      const payload = await apiGet<{ data: { keys: OpenRouterKeySummary[] } }>("/api/admin/openrouter-keys", sessionToken);
      setOpenRouterKeys(payload.data.keys);
      setSelectedOpenRouterKey(null);
    } catch (keysError) {
      setError(keysError instanceof Error ? keysError.message : "Could not load OpenRouter keys");
    } finally {
      setLoading(false);
    }
  }

  async function loadOpenRouterKeyDetail(hash: string): Promise<void> {
    setError("");
    setLoading(true);

    try {
      const payload = await apiGet<{ data: { key: OpenRouterKeySummary } }>(`/api/admin/openrouter-keys/${hash}`, sessionToken);
      setSelectedOpenRouterKey(payload.data.key);
    } catch (keyError) {
      setError(keyError instanceof Error ? keyError.message : "Could not load OpenRouter key details");
    } finally {
      setLoading(false);
    }
  }

  async function loadOpenRouterModels(): Promise<void> {
    setError("");
    setLoading(true);

    try {
      const payload = await apiGet<{ data: { models: OpenRouterModelRecord[] } }>("/api/admin/openrouter-models", sessionToken);
      setOpenRouterModels(payload.data.models);
    } catch (modelsError) {
      setError(modelsError instanceof Error ? modelsError.message : "Could not load OpenRouter models");
    } finally {
      setLoading(false);
    }
  }

  async function syncOpenRouterModels(): Promise<void> {
    setError("");
    setLoading(true);

    try {
      const payload = await apiPost<{ data: { models: OpenRouterModelRecord[]; count: number } }>(
        "/api/admin/openrouter-models/sync",
        sessionToken,
        {}
      );
      setOpenRouterModels(payload.data.models);
    } catch (modelsError) {
      setError(modelsError instanceof Error ? modelsError.message : "Could not sync OpenRouter models");
    } finally {
      setLoading(false);
    }
  }

  async function createApiKey(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError("");
    setCreatedGatewayKey("");
    setLoading(true);

    try {
      const response = await apiPost<{ data: { apiKey: string; record: ApiKeyRecord } }>(
        "/api/account/api-keys",
        sessionToken,
        { name: newKeyName }
      );
      setCreatedGatewayKey(response.data.apiKey);
      setSelectedGatewayKey(response.data.apiKey);
      await loadDashboard();
    } catch (keyError) {
      setError(keyError instanceof Error ? keyError.message : "Could not create API key");
    } finally {
      setLoading(false);
    }
  }

  async function revokeApiKey(id: string): Promise<void> {
    setError("");
    setLoading(true);

    try {
      await apiDelete(`/api/account/api-keys/${id}`, sessionToken);
      await loadDashboard();
    } catch (keyError) {
      setError(keyError instanceof Error ? keyError.message : "Could not revoke API key");
    } finally {
      setLoading(false);
    }
  }

  async function submitPrompt(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError("");
    setChatResult(null);
    setLoading(true);

    try {
      const response = await apiPost<ChatResponse>("/api/v1/chat", selectedGatewayKey, {
        messages,
        requestedTier: requestedTier || undefined,
        maxOutputTokens
      });
      setChatResult(response.data);
      await loadDashboard();
    } catch (chatError) {
      setError(chatError instanceof Error ? chatError.message : "Gateway request failed");
    } finally {
      setLoading(false);
    }
  }

  function preparePackageEdit(pkg: PackageRecord): void {
    setSelectedPackageId(pkg.id);
    setPackageForm({
      name: pkg.name,
      description: pkg.description ?? "",
      maxTier: pkg.maxTier,
      maxInputTokens: pkg.maxInputTokens,
      maxOutputTokens: pkg.maxOutputTokens,
      maxRagTokens: pkg.maxRagTokens,
      truncateInput: pkg.truncateInput,
      cacheEnabled: pkg.cacheEnabled,
      ragEnabled: pkg.ragEnabled,
      active: pkg.active,
      l1ModelId: pkg.l1ModelId,
      l2ModelId: pkg.l2ModelId ?? "",
      l3ModelId: pkg.l3ModelId ?? ""
    });
    navigateTo("/admin", setPath);
  }

  async function savePackage(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError("");
    setLoading(true);

    try {
      const body = {
        ...packageForm,
        l2ModelId: packageForm.l2ModelId || undefined,
        l3ModelId: packageForm.l3ModelId || undefined
      };

      if (selectedPackageId) {
        await apiPatch(`/api/admin/packages/${selectedPackageId}`, sessionToken, body);
      } else {
        await apiPost("/api/admin/packages", sessionToken, body);
      }

      setSelectedPackageId("");
      setPackageForm(emptyPackageForm);
      await loadDashboard();
    } catch (packageError) {
      setError(packageError instanceof Error ? packageError.message : "Could not save package");
    } finally {
      setLoading(false);
    }
  }

  async function createAdminUser(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError("");
    setLoading(true);

    try {
      await apiPost("/api/admin/users", sessionToken, adminUserForm);
      setAdminUserForm({
        email: "new-user@example.local",
        name: "New User",
        password: "user12345",
        isAdmin: false,
        packageId: adminUserForm.packageId
      });
      await loadDashboard();
    } catch (userError) {
      setError(userError instanceof Error ? userError.message : "Could not create user");
    } finally {
      setLoading(false);
    }
  }

  async function assignPackage(userId: string, packageId: string): Promise<void> {
    if (!packageId) return;

    setError("");
    setLoading(true);

    try {
      await apiPatch(`/api/admin/users/${userId}`, sessionToken, { packageId });
      await loadDashboard();
    } catch (userError) {
      setError(userError instanceof Error ? userError.message : "Could not update user package");
    } finally {
      setLoading(false);
    }
  }

  async function createModel(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError("");
    setLoading(true);

    try {
      await apiPost("/api/admin/models", sessionToken, modelForm);
      await loadDashboard();
    } catch (modelError) {
      setError(modelError instanceof Error ? modelError.message : "Could not create model");
    } finally {
      setLoading(false);
    }
  }

  function logout(): void {
    setSessionToken("");
    setUser(null);
    setPolicy(null);
    setAdmin(null);
    setOwnLogs([]);
    setApiKeys([]);
    setCreatedGatewayKey("");
    setOpenRouterKeys([]);
    setOpenRouterModels([]);
    setSelectedOpenRouterKey(null);
    navigateTo("/login", setPath);
  }

  if (!sessionToken) {
    return (
      <LoginPage
        email={email}
        error={error}
        loading={loading}
        password={password}
        setEmail={setEmail}
        setPassword={setPassword}
        onLogin={login}
      />
    );
  }

  return (
    <div className="app-frame">
      <Sidebar activePath={activePath} isAdmin={Boolean(user?.isAdmin)} setPath={setPath} onLogout={logout} />
      <main className="page-shell">
        <header className="page-header">
          <div>
            <p className="eyebrow">LLM Gateway</p>
            <h1>{titleForPath(activePath)}</h1>
          </div>
          <div className="header-actions">
            <span>{user?.email ?? "Session active"}</span>
            <button type="button" onClick={() => void loadDashboard()} disabled={loading}>
              Refresh
            </button>
          </div>
        </header>

        {error ? <p className="error-banner">{error}</p> : null}

        {activePath === "/dashboard" ? (
          <DashboardPage
            admin={admin}
            apiKeys={apiKeys}
            logs={logs}
            policy={policy}
            setPath={setPath}
            setUsageRange={setUsageRange}
            usageRange={usageRange}
            usageSummary={usageSummary}
            user={user}
          />
        ) : null}
        {activePath === "/admin" && user?.isAdmin ? (
          <AdminPage
            admin={admin}
            adminUserForm={adminUserForm}
            createAdminUser={createAdminUser}
            createModel={createModel}
            loading={loading}
            modelForm={modelForm}
            modelOptions={modelOptions}
            packageForm={packageForm}
            preparePackageEdit={preparePackageEdit}
            savePackage={savePackage}
            selectedPackageId={selectedPackageId}
            setAdminUserForm={setAdminUserForm}
            setModelForm={setModelForm}
            setPackageForm={setPackageForm}
            setSelectedPackageId={setSelectedPackageId}
            assignPackage={assignPackage}
          />
        ) : null}
        {activePath === "/api-keys" ? (
          <ApiKeysPage
            apiKeys={apiKeys}
            createdGatewayKey={createdGatewayKey}
            createApiKey={createApiKey}
            loading={loading}
            newKeyName={newKeyName}
            revokeApiKey={revokeApiKey}
            setNewKeyName={setNewKeyName}
          />
        ) : null}
        {activePath === "/openrouter-keys" && user?.isAdmin ? (
          <OpenRouterKeysPage
            keys={openRouterKeys}
            loading={loading}
            reload={loadOpenRouterKeys}
            selectedKey={selectedOpenRouterKey}
            showDetails={loadOpenRouterKeyDetail}
          />
        ) : null}
        {activePath === "/openrouter-models" && user?.isAdmin ? (
          <OpenRouterModelsPage
            loading={loading}
            models={openRouterModels}
            reload={loadOpenRouterModels}
            syncModels={syncOpenRouterModels}
          />
        ) : null}
        {activePath === "/tester" ? (
          <TesterPage
            chatResult={chatResult}
            loading={loading}
            maxOutputTokens={maxOutputTokens}
            prompt={prompt}
            requestedTier={requestedTier}
            selectedGatewayKey={selectedGatewayKey}
            setMaxOutputTokens={setMaxOutputTokens}
            setPrompt={setPrompt}
            setRequestedTier={setRequestedTier}
            setSelectedGatewayKey={setSelectedGatewayKey}
            submitPrompt={submitPrompt}
          />
        ) : null}
        {activePath === "/logs" ? <LogsPage logs={logs} user={user} /> : null}
        {activePath === "/policy" ? <PolicyPage admin={admin} policy={policy} /> : null}
      </main>
    </div>
  );
}

function LoginPage(props: {
  email: string;
  error: string;
  loading: boolean;
  password: string;
  setEmail: (value: string) => void;
  setPassword: (value: string) => void;
  onLogin: (event: FormEvent) => Promise<void>;
}): ReactElement {
  return (
    <main className="shell narrow">
      <section className="intro-band single">
        <div>
          <p className="eyebrow">LLM Gateway Login</p>
          <h1>Sign in to create gateway keys and review prompt usage.</h1>
        </div>
      </section>
      {props.error ? <p className="error-banner">{props.error}</p> : null}
      <form className="tool-panel" onSubmit={(event) => void props.onLogin(event)}>
        <label>
          Email
          <input value={props.email} onChange={(event) => props.setEmail(event.target.value)} autoComplete="email" />
        </label>
        <label>
          Password
          <input
            type="password"
            value={props.password}
            onChange={(event) => props.setPassword(event.target.value)}
            autoComplete="current-password"
          />
        </label>
        <button type="submit" disabled={props.loading || !props.email || !props.password}>
          {props.loading ? "Signing in" : "Sign in"}
        </button>
        <p className="muted">Seed login: admin@example.local / admin12345</p>
      </form>
    </main>
  );
}

function Sidebar(props: {
  activePath: RoutePath;
  isAdmin: boolean;
  setPath: (value: string) => void;
  onLogout: () => void;
}): ReactElement {
  const links = [
    { path: "/dashboard" as RoutePath, label: "Dashboard" },
    { path: "/admin" as RoutePath, label: "Admin", adminOnly: true },
    { path: "/api-keys" as RoutePath, label: "API Keys" },
    { path: "/openrouter-keys" as RoutePath, label: "OpenRouter Keys", adminOnly: true },
    { path: "/openrouter-models" as RoutePath, label: "OpenRouter Models", adminOnly: true },
    { path: "/tester" as RoutePath, label: "Tester" },
    { path: "/logs" as RoutePath, label: "Logs" },
    { path: "/policy" as RoutePath, label: "Policy" }
  ].filter((link) => !link.adminOnly || props.isAdmin);

  return (
    <aside className="sidebar">
      <div className="brand-block">
        <strong>LLM Gateway</strong>
        <span>Policy routing</span>
      </div>
      <nav className="side-nav">
        {links.map((link) => (
          <a
            className={props.activePath === link.path ? "active" : ""}
            href={link.path}
            key={link.path}
            onClick={(event) => {
              event.preventDefault();
              navigateTo(link.path, props.setPath);
            }}
          >
            {link.label}
            <small>{link.path}</small>
          </a>
        ))}
      </nav>
      <button type="button" className="secondary" onClick={props.onLogout}>Logout</button>
    </aside>
  );
}

function DashboardPage(props: {
  admin: AdminData | null;
  apiKeys: ApiKeyRecord[];
  logs: RequestLog[];
  policy: PolicyData | null;
  setUsageRange: (range: UsageRange) => void;
  user: UserSummary | null;
  setPath: (value: string) => void;
  usageRange: UsageRange;
  usageSummary: UsageSummary | null;
}): ReactElement {
  return (
    <section className="page-grid">
      <Metric label="Signed in" value={props.user?.email ?? "-"} />
      <Metric label="Max tier" value={props.policy?.policy.maxTier ?? "-"} />
      <Metric label="Gateway keys" value={props.apiKeys.length} />
      <Metric label="Total cost" value={formatCost(props.usageSummary?.totals.cost ?? null)} />
      <Metric label="Total tokens" value={formatNumber(props.usageSummary?.totals.totalTokens ?? 0)} />
      <Metric label="Output tokens" value={formatNumber(props.usageSummary?.totals.outputTokens ?? 0)} />
      <Metric label="Requests" value={props.usageSummary?.totals.requests ?? props.logs.length} />
      {props.admin ? <Metric label="Users" value={props.admin.users.length} /> : null}
      {props.admin ? <Metric label="Packages" value={props.admin.packages.length} /> : null}
      <section className="data-band wide">
        <div className="section-heading split-heading">
          <div>
            <p className="eyebrow">Usage analytics</p>
            <h2>Cost and token usage by time range</h2>
          </div>
          <select value={props.usageRange} onChange={(event) => props.setUsageRange(event.target.value as UsageRange)}>
            <option value="24h">Last 24 hours</option>
            <option value="7d">Last 7 days</option>
            <option value="30d">Last 30 days</option>
            <option value="90d">Last 90 days</option>
          </select>
        </div>
        {props.usageSummary ? (
          <div className="chart-grid">
            <UsageChart
              buckets={props.usageSummary.buckets}
              label="Cost"
              valueKey="cost"
              formatter={formatCost}
            />
            <UsageChart
              buckets={props.usageSummary.buckets}
              label="Total tokens"
              valueKey="totalTokens"
              formatter={formatNumber}
            />
            <UsageChart
              buckets={props.usageSummary.buckets}
              label="Output tokens"
              valueKey="outputTokens"
              formatter={formatNumber}
            />
          </div>
        ) : (
          <p className="muted">Usage summary is loading.</p>
        )}
      </section>
      <section className="data-band wide">
        <div className="section-heading">
          <p className="eyebrow">Quick actions</p>
          <h2>Common paths</h2>
        </div>
        <div className="quick-actions">
          {([
            "/api-keys",
            ...(props.user?.isAdmin ? ["/openrouter-keys", "/openrouter-models"] : []),
            "/tester",
            "/logs",
            "/policy"
          ] as RoutePath[]).map((route) => (
            <button key={route} type="button" className="secondary" onClick={() => navigateTo(route, props.setPath)}>
              {titleForPath(route)}
            </button>
          ))}
          {props.user?.isAdmin ? (
            <button type="button" className="secondary" onClick={() => navigateTo("/admin", props.setPath)}>
              Admin
            </button>
          ) : null}
        </div>
      </section>
    </section>
  );
}

function ApiKeysPage(props: {
  apiKeys: ApiKeyRecord[];
  createdGatewayKey: string;
  createApiKey: (event: FormEvent) => Promise<void>;
  loading: boolean;
  newKeyName: string;
  revokeApiKey: (id: string) => Promise<void>;
  setNewKeyName: (value: string) => void;
}): ReactElement {
  return (
    <section className="data-band">
      <div className="section-heading">
        <p className="eyebrow">API keys</p>
        <h2>Connect Claude, Roo Code, Codex, or another client</h2>
      </div>
      <form className="inline-form" onSubmit={(event) => void props.createApiKey(event)}>
        <input value={props.newKeyName} onChange={(event) => props.setNewKeyName(event.target.value)} />
        <button type="submit" disabled={props.loading || !props.newKeyName.trim()}>Create key</button>
      </form>
      {props.createdGatewayKey ? (
        <div className="secret-box">
          <strong>New key</strong>
          <code>{props.createdGatewayKey}</code>
          <small>Store this now. The plaintext key is shown only once.</small>
        </div>
      ) : null}
      <div className="model-list">
        {props.apiKeys.map((key) => (
          <article key={key.id} className="model-item">
            <strong>{key.name}</strong>
            <span>{key.status} - created {formatDate(key.createdAt)}</span>
            <small>Last used: {key.lastUsedAt ? formatDate(key.lastUsedAt) : "never"}</small>
            <button type="button" className="secondary" onClick={() => void props.revokeApiKey(key.id)} disabled={key.status === "REVOKED"}>
              Revoke
            </button>
          </article>
        ))}
      </div>
    </section>
  );
}

function OpenRouterKeysPage(props: {
  keys: OpenRouterKeySummary[];
  loading: boolean;
  reload: () => Promise<void>;
  selectedKey: OpenRouterKeySummary | null;
  showDetails: (hash: string) => Promise<void>;
}): ReactElement {
  const totals = props.keys.reduce((sum, key) => ({
    usage: sum.usage + numericValue(key.usage),
    byokUsage: sum.byokUsage + numericValue(key.byok_usage),
    limitRemaining: sum.limitRemaining + numericValue(key.limit_remaining),
    weeklyUsage: sum.weeklyUsage + numericValue(key.usage_weekly)
  }), {
    usage: 0,
    byokUsage: 0,
    limitRemaining: 0,
    weeklyUsage: 0
  });

  return (
    <section className="stack">
      <div className="page-grid">
        <Metric label="Keys" value={props.keys.length} />
        <Metric label="Usage" value={formatCost(totals.usage)} />
        <Metric label="BYOK usage" value={formatCost(totals.byokUsage)} />
        <Metric label="Weekly usage" value={formatCost(totals.weeklyUsage)} />
        <Metric label="Remaining limit" value={formatCost(totals.limitRemaining)} />
      </div>
      <section className="data-band">
        <div className="section-heading split-heading">
          <div>
            <p className="eyebrow">OpenRouter management</p>
            <h2>Provider API keys from OpenRouter</h2>
          </div>
          <button type="button" onClick={() => void props.reload()} disabled={props.loading}>
            Refresh keys
          </button>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Label</th>
                <th>Status</th>
                <th>Usage</th>
                <th>BYOK</th>
                <th>Daily</th>
                <th>Weekly</th>
                <th>Monthly</th>
                <th>Limit</th>
                <th>Remaining</th>
                <th>Reset</th>
                <th>Expires</th>
                <th>Hash</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {props.keys.map((key) => (
                <tr key={key.hash}>
                  <td>{key.name}</td>
                  <td>{key.label ?? "-"}</td>
                  <td><span className={`status ${key.disabled ? "failed" : "success"}`}>{key.disabled ? "Disabled" : "Active"}</span></td>
                  <td>{formatCost(key.usage)}</td>
                  <td>{formatCost(key.byok_usage)}</td>
                  <td>{formatCost(key.usage_daily)}</td>
                  <td>{formatCost(key.usage_weekly)}</td>
                  <td>{formatCost(key.usage_monthly)}</td>
                  <td>{key.limit === null ? "-" : formatCost(key.limit)}</td>
                  <td>{key.limit_remaining === null ? "-" : formatCost(key.limit_remaining)}</td>
                  <td>{key.limit_reset ?? "-"}</td>
                  <td>{key.expires_at ? formatDate(key.expires_at) : "-"}</td>
                  <td><code>{shortHash(key.hash)}</code></td>
                  <td>
                    <button type="button" className="secondary compact-button" onClick={() => void props.showDetails(key.hash)} disabled={props.loading}>
                      View
                    </button>
                  </td>
                </tr>
              ))}
              {!props.keys.length ? (
                <tr>
                  <td colSpan={14}>No OpenRouter keys loaded. Configure OPENROUTER_MANAGEMENT_KEY and refresh.</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        {props.selectedKey ? (
          <div className="detail-panel">
            <div className="section-heading">
              <p className="eyebrow">Key detail</p>
              <h2>{props.selectedKey.name}</h2>
            </div>
            <div className="metrics-grid compact">
              <Metric label="Usage" value={formatCost(props.selectedKey.usage)} />
              <Metric label="Daily" value={formatCost(props.selectedKey.usage_daily)} />
              <Metric label="Weekly" value={formatCost(props.selectedKey.usage_weekly)} />
              <Metric label="Monthly" value={formatCost(props.selectedKey.usage_monthly)} />
              <Metric label="BYOK" value={formatCost(props.selectedKey.byok_usage)} />
              <Metric label="Remaining" value={props.selectedKey.limit_remaining === null ? "-" : formatCost(props.selectedKey.limit_remaining)} />
            </div>
            <div className="secret-box">
              <strong>Hash</strong>
              <code>{props.selectedKey.hash}</code>
              <small>Creator: {props.selectedKey.creator_user_id} | Updated: {formatDate(props.selectedKey.updated_at)}</small>
            </div>
          </div>
        ) : null}
      </section>
    </section>
  );
}

function OpenRouterModelsPage(props: {
  loading: boolean;
  models: OpenRouterModelRecord[];
  reload: () => Promise<void>;
  syncModels: () => Promise<void>;
}): ReactElement {
  const latestSync = props.models.reduce<string | null>((latest, model) => {
    if (!latest) return model.syncedAt;
    return new Date(model.syncedAt) > new Date(latest) ? model.syncedAt : latest;
  }, null);

  return (
    <section className="stack">
      <div className="page-grid">
        <Metric label="Models" value={props.models.length} />
        <Metric label="Latest sync" value={latestSync ? formatDate(latestSync) : "-"} />
        <Metric label="With pricing" value={props.models.filter((model) => model.inputCostPer1M || model.outputCostPer1M).length} />
        <Metric label="With context" value={props.models.filter((model) => model.contextLength !== null).length} />
      </div>
      <section className="data-band">
        <div className="section-heading split-heading">
          <div>
            <p className="eyebrow">OpenRouter model catalog</p>
            <h2>Synced provider models</h2>
          </div>
          <div className="key-row">
            <button type="button" className="secondary" onClick={() => void props.reload()} disabled={props.loading}>
              Refresh table
            </button>
            <button type="button" onClick={() => void props.syncModels()} disabled={props.loading}>
              Sync from OpenRouter
            </button>
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Model ID</th>
                <th>Name</th>
                <th>Context</th>
                <th>Input / 1M</th>
                <th>Output / 1M</th>
                <th>Tokenizer</th>
                <th>Modality</th>
                <th>OpenRouter created</th>
                <th>Synced</th>
              </tr>
            </thead>
            <tbody>
              {props.models.map((model) => (
                <tr key={model.id}>
                  <td><code>{model.modelId}</code></td>
                  <td>{model.name ?? "-"}</td>
                  <td>{model.contextLength === null ? "-" : formatNumber(model.contextLength)}</td>
                  <td>{formatCostPerMillion(model.inputCostPer1M)}</td>
                  <td>{formatCostPerMillion(model.outputCostPer1M)}</td>
                  <td>{model.tokenizer ?? "-"}</td>
                  <td>{model.modality ?? "-"}</td>
                  <td>{model.openRouterCreatedAt ? formatDate(model.openRouterCreatedAt) : "-"}</td>
                  <td>{formatDate(model.syncedAt)}</td>
                </tr>
              ))}
              {!props.models.length ? (
                <tr>
                  <td colSpan={9}>No OpenRouter models stored yet. Configure an OpenRouter token and click sync.</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
    </section>
  );
}

function TesterPage(props: {
  chatResult: ChatResponse["data"] | null;
  loading: boolean;
  maxOutputTokens: number;
  prompt: string;
  requestedTier: string;
  selectedGatewayKey: string;
  setMaxOutputTokens: (value: number) => void;
  setPrompt: (value: string) => void;
  setRequestedTier: (value: string) => void;
  setSelectedGatewayKey: (value: string) => void;
  submitPrompt: (event: FormEvent) => Promise<void>;
}): ReactElement {
  return (
    <section className="stack">
      <form className="tool-panel" onSubmit={(event) => void props.submitPrompt(event)}>
        <div className="section-heading">
          <p className="eyebrow">Request tester</p>
          <h2>Send one gateway request</h2>
        </div>
        <label>
          Gateway API key
          <input value={props.selectedGatewayKey} onChange={(event) => props.setSelectedGatewayKey(event.target.value)} autoComplete="off" />
        </label>
        <label htmlFor="prompt">Prompt</label>
        <textarea id="prompt" value={props.prompt} onChange={(event) => props.setPrompt(event.target.value)} rows={7} />
        <div className="form-grid">
          <label>
            Tier override
            <select value={props.requestedTier} onChange={(event) => props.setRequestedTier(event.target.value)}>
              <option value="">Start from L1</option>
              <option value="L1">L1</option>
              <option value="L2">L2</option>
              <option value="L3">L3</option>
            </select>
          </label>
          <label>
            Max output tokens
            <input type="number" min="1" value={props.maxOutputTokens} onChange={(event) => props.setMaxOutputTokens(Number(event.target.value))} />
          </label>
        </div>
        <button type="submit" disabled={props.loading || !props.selectedGatewayKey || !props.prompt.trim()}>
          {props.loading ? "Running" : "Run request"}
        </button>
      </form>
      {props.chatResult ? (
        <section className="result-panel">
          <div className="section-heading">
            <p className="eyebrow">Gateway response</p>
            <h2>{props.chatResult.selectedTier} - {props.chatResult.selectedModel}</h2>
          </div>
          <pre>{props.chatResult.content}</pre>
          <div className="metrics-grid">
            <Metric label="Input estimate" value={props.chatResult.inputTokensEstimated} />
            <Metric label="Output limit" value={props.chatResult.outputTokensLimit} />
            <Metric label="Provider total" value={props.chatResult.providerTotalTokens ?? "-"} />
            <Metric label="Escalations" value={props.chatResult.escalationAttempts} />
          </div>
        </section>
      ) : null}
    </section>
  );
}

function LogsPage(props: { logs: RequestLog[]; user: UserSummary | null }): ReactElement {
  return (
    <section className="data-band">
      <div className="section-heading">
        <p className="eyebrow">Prompt usage log</p>
        <h2>Recent gateway calls</h2>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Status</th>
              <th>User</th>
              <th>Prompt</th>
              <th>Model</th>
              <th>Input</th>
              <th>Output</th>
              <th>Total</th>
              <th>Cost</th>
              <th>Error</th>
            </tr>
          </thead>
          <tbody>
            {props.logs.map((log) => (
              <tr key={log.id}>
                <td><span className={`status ${log.status.toLowerCase()}`}>{log.status}</span></td>
                <td>{log.user?.email ?? props.user?.email ?? "-"}</td>
                <td>{log.promptPreview ?? "-"}</td>
                <td>{log.selectedModel ?? "-"}</td>
                <td>{log.providerInputTokens ?? log.inputTokensEstimated}</td>
                <td>{log.providerOutputTokens ?? log.outputTokensLimit}</td>
                <td>{log.providerTotalTokens ?? "-"}</td>
                <td>{formatCost(log.providerCost)}</td>
                <td>{log.errorMessage ?? log.errorCategory}</td>
              </tr>
            ))}
            {!props.logs.length ? (
              <tr>
                <td colSpan={9}>No prompt usage has been logged yet.</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function PolicyPage(props: { admin: AdminData | null; policy: PolicyData | null }): ReactElement {
  return (
    <section className="layout">
      <section className="data-band">
        <div className="section-heading">
          <p className="eyebrow">Effective policy</p>
          <h2>{props.policy?.user.email ?? "Not loaded"}</h2>
        </div>
        {props.policy ? (
          <>
            <div className="metrics-grid compact">
              <Metric label="Max tier" value={props.policy.policy.maxTier} />
              <Metric label="Input cap" value={props.policy.policy.maxInputTokens} />
              <Metric label="Output cap" value={props.policy.policy.maxOutputTokens} />
              <Metric label="RAG cap" value={props.policy.policy.maxRagTokens} />
            </div>
            <div className="flag-row">
              <Flag label="Cache" enabled={props.policy.policy.cacheEnabled} />
              <Flag label="RAG" enabled={props.policy.policy.ragEnabled} />
              <Flag label="Truncate" enabled={props.policy.policy.truncateInput} />
            </div>
            <div className="model-list">
              {Object.entries(props.policy.policy.models).map(([tier, model]) => (
                <article key={tier} className="model-item">
                  <strong>{tier}</strong>
                  <span>{model?.displayName ?? "Not configured"}</span>
                  <small>{model?.modelName ?? "-"}</small>
                </article>
              ))}
            </div>
          </>
        ) : <p className="muted">Refresh the dashboard to load policy data.</p>}
      </section>
      <section className="data-band">
        <div className="section-heading">
          <p className="eyebrow">Providers</p>
          <h2>{props.admin?.providers.length ?? 0} configured</h2>
        </div>
        <div className="model-list">
          {(props.admin?.providers ?? []).map((provider) => (
            <article key={provider.id} className="model-item">
              <strong>{provider.name}</strong>
              <span>{provider.active ? "Active" : "Disabled"} - {provider.apiKeyEnvVar}</span>
              <small>{provider.models.length} models - {provider.baseUrl}</small>
            </article>
          ))}
          {!props.admin?.providers.length ? <p className="muted">Provider data is available to admin users.</p> : null}
        </div>
      </section>
    </section>
  );
}

function AdminPage(props: {
  admin: AdminData | null;
  adminUserForm: {
    email: string;
    name: string;
    password: string;
    isAdmin: boolean;
    packageId: string;
  };
  assignPackage: (userId: string, packageId: string) => Promise<void>;
  createAdminUser: (event: FormEvent) => Promise<void>;
  createModel: (event: FormEvent) => Promise<void>;
  loading: boolean;
  modelForm: {
    providerId: string;
    displayName: string;
    modelName: string;
    tier: string;
    maxContextTokens: number;
    maxOutputTokens: number;
    active: boolean;
  };
  modelOptions: Array<AdminData["providers"][number]["models"][number] & { providerName: string }>;
  packageForm: typeof emptyPackageForm;
  preparePackageEdit: (pkg: PackageRecord) => void;
  savePackage: (event: FormEvent) => Promise<void>;
  selectedPackageId: string;
  setAdminUserForm: (value: {
    email: string;
    name: string;
    password: string;
    isAdmin: boolean;
    packageId: string;
  }) => void;
  setModelForm: (value: {
    providerId: string;
    displayName: string;
    modelName: string;
    tier: string;
    maxContextTokens: number;
    maxOutputTokens: number;
    active: boolean;
  }) => void;
  setPackageForm: (value: typeof emptyPackageForm) => void;
  setSelectedPackageId: (value: string) => void;
}): ReactElement {
  return (
    <section className="stack">
      <div className="admin-grid">
        <form className="admin-card" onSubmit={(event) => void props.createAdminUser(event)}>
          <h3>Create user</h3>
          <input value={props.adminUserForm.email} onChange={(event) => props.setAdminUserForm({ ...props.adminUserForm, email: event.target.value })} placeholder="Email" />
          <input value={props.adminUserForm.name} onChange={(event) => props.setAdminUserForm({ ...props.adminUserForm, name: event.target.value })} placeholder="Name" />
          <input type="password" value={props.adminUserForm.password} onChange={(event) => props.setAdminUserForm({ ...props.adminUserForm, password: event.target.value })} placeholder="Password" />
          <select value={props.adminUserForm.packageId} onChange={(event) => props.setAdminUserForm({ ...props.adminUserForm, packageId: event.target.value })}>
            <option value="">Select package</option>
            {(props.admin?.packages ?? []).map((pkg) => <option key={pkg.id} value={pkg.id}>{pkg.name}</option>)}
          </select>
          <label className="checkbox-row">
            <input type="checkbox" checked={props.adminUserForm.isAdmin} onChange={(event) => props.setAdminUserForm({ ...props.adminUserForm, isAdmin: event.target.checked })} />
            Admin user
          </label>
          <button type="submit" disabled={props.loading || !props.adminUserForm.packageId}>Create user</button>
        </form>

        <form className="admin-card" onSubmit={(event) => void props.savePackage(event)}>
          <h3>{props.selectedPackageId ? "Edit package" : "Create package"}</h3>
          <input value={props.packageForm.name} onChange={(event) => props.setPackageForm({ ...props.packageForm, name: event.target.value })} placeholder="Package name" />
          <input value={props.packageForm.description} onChange={(event) => props.setPackageForm({ ...props.packageForm, description: event.target.value })} placeholder="Description" />
          <div className="form-grid no-margin">
            <label>
              Max tier
              <select value={props.packageForm.maxTier} onChange={(event) => props.setPackageForm({ ...props.packageForm, maxTier: event.target.value })}>
                <option value="L1">L1</option>
                <option value="L2">L2</option>
                <option value="L3">L3</option>
              </select>
            </label>
            <label>
              Input
              <input type="number" min="1" value={props.packageForm.maxInputTokens} onChange={(event) => props.setPackageForm({ ...props.packageForm, maxInputTokens: Number(event.target.value) })} />
            </label>
            <label>
              Output
              <input type="number" min="1" value={props.packageForm.maxOutputTokens} onChange={(event) => props.setPackageForm({ ...props.packageForm, maxOutputTokens: Number(event.target.value) })} />
            </label>
            <label>
              RAG
              <input type="number" min="0" value={props.packageForm.maxRagTokens} onChange={(event) => props.setPackageForm({ ...props.packageForm, maxRagTokens: Number(event.target.value) })} />
            </label>
          </div>
          {(["l1ModelId", "l2ModelId", "l3ModelId"] as const).map((field, index) => (
            <select key={field} value={props.packageForm[field]} onChange={(event) => props.setPackageForm({ ...props.packageForm, [field]: event.target.value })}>
              <option value="">{`L${index + 1} model`}</option>
              {props.modelOptions.map((model) => <option key={model.id} value={model.id}>{model.providerName} - {model.displayName}</option>)}
            </select>
          ))}
          <div className="flag-row">
            <Checkbox label="Truncate" checked={props.packageForm.truncateInput} onChange={(checked) => props.setPackageForm({ ...props.packageForm, truncateInput: checked })} />
            <Checkbox label="Cache" checked={props.packageForm.cacheEnabled} onChange={(checked) => props.setPackageForm({ ...props.packageForm, cacheEnabled: checked })} />
            <Checkbox label="RAG" checked={props.packageForm.ragEnabled} onChange={(checked) => props.setPackageForm({ ...props.packageForm, ragEnabled: checked })} />
            <Checkbox label="Active" checked={props.packageForm.active} onChange={(checked) => props.setPackageForm({ ...props.packageForm, active: checked })} />
          </div>
          <div className="key-row">
            <button type="submit" disabled={props.loading || !props.packageForm.l1ModelId}>Save package</button>
            <button type="button" className="secondary" onClick={() => {
              props.setSelectedPackageId("");
              props.setPackageForm(emptyPackageForm);
            }}>New</button>
          </div>
        </form>

        <form className="admin-card" onSubmit={(event) => void props.createModel(event)}>
          <h3>Add model</h3>
          <select value={props.modelForm.providerId} onChange={(event) => props.setModelForm({ ...props.modelForm, providerId: event.target.value })}>
            <option value="">Provider</option>
            {(props.admin?.providers ?? []).map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}
          </select>
          <input value={props.modelForm.displayName} onChange={(event) => props.setModelForm({ ...props.modelForm, displayName: event.target.value })} placeholder="Display name" />
          <input value={props.modelForm.modelName} onChange={(event) => props.setModelForm({ ...props.modelForm, modelName: event.target.value })} placeholder="Provider model name" />
          <div className="form-grid no-margin">
            <label>
              Tier
              <select value={props.modelForm.tier} onChange={(event) => props.setModelForm({ ...props.modelForm, tier: event.target.value })}>
                <option value="L1">L1</option>
                <option value="L2">L2</option>
                <option value="L3">L3</option>
              </select>
            </label>
            <label>
              Context
              <input type="number" min="1" value={props.modelForm.maxContextTokens} onChange={(event) => props.setModelForm({ ...props.modelForm, maxContextTokens: Number(event.target.value) })} />
            </label>
            <label>
              Output
              <input type="number" min="1" value={props.modelForm.maxOutputTokens} onChange={(event) => props.setModelForm({ ...props.modelForm, maxOutputTokens: Number(event.target.value) })} />
            </label>
          </div>
          <Checkbox label="Active" checked={props.modelForm.active} onChange={(checked) => props.setModelForm({ ...props.modelForm, active: checked })} />
          <button type="submit" disabled={props.loading || !props.modelForm.providerId}>Add model</button>
        </form>
      </div>

      <div className="admin-grid lower">
        <section className="admin-card">
          <h3>Users</h3>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>User</th>
                  <th>Package</th>
                  <th>Status</th>
                  <th>Assign</th>
                </tr>
              </thead>
              <tbody>
                {(props.admin?.users ?? []).map((adminUser) => (
                  <tr key={adminUser.id}>
                    <td>{adminUser.email}</td>
                    <td>{adminUser.packageName ?? "-"}</td>
                    <td>{adminUser.status}</td>
                    <td>
                      <select value={adminUser.packageId ?? ""} onChange={(event) => void props.assignPackage(adminUser.id, event.target.value)}>
                        <option value="">Select package</option>
                        {(props.admin?.packages ?? []).map((pkg) => <option key={pkg.id} value={pkg.id}>{pkg.name}</option>)}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="admin-card">
          <h3>Packages</h3>
          <div className="model-list">
            {(props.admin?.packages ?? []).map((pkg) => (
              <article key={pkg.id} className="model-item">
                <strong>{pkg.name}</strong>
                <span>{pkg.maxTier} - {pkg.userCount} users - {pkg.active ? "Active" : "Disabled"}</span>
                <small>L1 {pkg.models.L1 ?? "-"} | L2 {pkg.models.L2 ?? "-"} | L3 {pkg.models.L3 ?? "-"}</small>
                <button type="button" className="secondary" onClick={() => props.preparePackageEdit(pkg)}>Edit</button>
              </article>
            ))}
          </div>
        </section>
      </div>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string | number }): ReactElement {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function UsageChart(props: {
  buckets: UsageSummary["buckets"];
  formatter: (value: number) => string;
  label: string;
  valueKey: "cost" | "totalTokens" | "outputTokens";
}): ReactElement {
  const maxValue = Math.max(...props.buckets.map((bucket) => bucket[props.valueKey]), 0);

  return (
    <article className="chart-card">
      <div className="chart-title">
        <strong>{props.label}</strong>
        <span>{props.formatter(props.buckets.reduce((sum, bucket) => sum + bucket[props.valueKey], 0))}</span>
      </div>
      <div className="bar-chart">
        {props.buckets.map((bucket) => {
          const value = bucket[props.valueKey];
          const height = maxValue > 0 ? Math.max(4, (value / maxValue) * 100) : 4;

          return (
            <div className="bar-column" key={bucket.label} title={`${bucket.label}: ${props.formatter(value)}`}>
              <span style={{ height: `${height}%` }} />
            </div>
          );
        })}
      </div>
      <div className="chart-axis">
        <small>{props.buckets[0]?.label ?? "-"}</small>
        <small>{props.buckets[props.buckets.length - 1]?.label ?? "-"}</small>
      </div>
    </article>
  );
}

function Flag({ label, enabled }: { label: string; enabled: boolean }): ReactElement {
  return <span className={`flag ${enabled ? "on" : "off"}`}>{label}: {enabled ? "ON" : "OFF"}</span>;
}

function Checkbox(props: { label: string; checked: boolean; onChange: (checked: boolean) => void }): ReactElement {
  return (
    <label className="checkbox-row">
      <input type="checkbox" checked={props.checked} onChange={(event) => props.onChange(event.target.checked)} />
      {props.label}
    </label>
  );
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString();
}

function formatCost(value: string | number | null): string {
  if (value === null || value === undefined) {
    return "-";
  }

  const amount = typeof value === "number" ? value : Number(value);

  if (!Number.isFinite(amount)) {
    return "-";
  }

  return `$${amount.toFixed(6)}`;
}

function formatCostPerMillion(value: string | null): string {
  if (value === null) {
    return "-";
  }

  const amount = Number(value);

  if (!Number.isFinite(amount)) {
    return "-";
  }

  return `$${amount.toFixed(6)}`;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(value);
}

function titleForPath(path: RoutePath): string {
  const titles: Record<RoutePath, string> = {
    "/dashboard": "Dashboard",
    "/admin": "Admin",
    "/api-keys": "API Keys",
    "/openrouter-keys": "OpenRouter Keys",
    "/openrouter-models": "OpenRouter Models",
    "/tester": "Request Tester",
    "/logs": "Prompt Logs",
    "/policy": "Policy"
  };
  return titles[path];
}

function numericValue(value: number | null): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function shortHash(hash: string): string {
  if (hash.length <= 16) {
    return hash;
  }

  return `${hash.slice(0, 8)}...${hash.slice(-8)}`;
}

function navigateTo(path: string, setPath: (value: string) => void): void {
  window.history.pushState({}, "", path);
  setPath(window.location.pathname);
}

function usePathname(): [string, (value: string) => void] {
  const [path, setPath] = useState(window.location.pathname);

  useEffect(() => {
    const update = (): void => setPath(window.location.pathname);
    window.addEventListener("popstate", update);
    return () => window.removeEventListener("popstate", update);
  }, []);

  return [path, setPath];
}
