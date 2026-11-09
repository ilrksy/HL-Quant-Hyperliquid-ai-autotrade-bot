import type { PresetView } from "../../shared/types";

// catalogue of supported providers; model ids drift, so the providers page can also fetch live model lists
export const PRESETS: PresetView[] = [
  {
    id: "gemini", name: "Google Gemini (AI Studio)", kind: "openai",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", keyRequired: true,
    models: ["gemini-3.8-flash", "gemini-3.5-flash-lite", "gemini-flash-latest", "gemma-4-31b-it"], rpm: 10,
    pricing: "Free tier: Flash, Flash-Lite and Gemma 4 (per-project quotas)", signupUrl: "https://aistudio.google.com/apikey",
    notes: "Restrict each key to the Generative Language API; unrestricted keys are rejected since June 2026.",
  },
  {
    id: "antigravity", name: "Google Antigravity Agent", kind: "antigravity",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta", keyRequired: true,
    models: ["antigravity-preview-09-2026"], rpm: 2,
    pricing: "Preview; free-tier quota on Gemini API keys, then billed per token",
    signupUrl: "https://aistudio.google.com/apikey",
    notes: "Managed agent that browses the web. Takes minutes, so it only powers the Deep Research analyst.",
  },
  {
    id: "xai", name: "xAI Grok", kind: "openai", baseUrl: "https://api.x.ai/v1", keyRequired: true,
    models: ["grok-4.20-0309-non-reasoning", "grok-build-0.1", "grok-4.3", "grok-4.7"], rpm: 30,
    pricing: "Paid only (no free credits), from $1 per 1M input tokens", signupUrl: "https://console.x.ai",
    notes: "Non-reasoning model is fastest for short JSON decisions.",
  },
  {
    id: "groq", name: "Groq", kind: "openai", baseUrl: "https://api.groq.com/openai/v1", keyRequired: true,
    models: ["openai/gpt-oss-120b", "llama-3.3-70b-versatile", "qwen/qwen3.6-27b", "llama-3.1-8b-instant"], rpm: 30,
    pricing: "Free tier ~30 RPM", signupUrl: "https://console.groq.com/keys", notes: "Very low latency.",
  },
  {
    id: "cerebras", name: "Cerebras", kind: "openai", baseUrl: "https://api.cerebras.ai/v1", keyRequired: true,
    models: ["gpt-oss-120b", "qwen-3.8-27b"], rpm: 5, pricing: "Free tier ~5 RPM",
    signupUrl: "https://cloud.cerebras.ai", notes: "",
  },
  {
    id: "openrouter", name: "OpenRouter", kind: "openai", baseUrl: "https://openrouter.ai/api/v1", keyRequired: true,
    models: ["google/gemma-4-31b-it:free", "google/gemma-4-26b-a4b-it:free"], rpm: 20,
    pricing: "Free :free models, 20 RPM / 50 RPD (1000 RPD with $10 credit)", signupUrl: "https://openrouter.ai/keys",
    notes: "One key reaches hundreds of models; use Fetch models to pick others.",
  },
  {
    id: "mistral", name: "Mistral", kind: "openai", baseUrl: "https://api.mistral.ai/v1", keyRequired: true,
    models: ["mistral-small-latest", "open-mistral-nemo"], rpm: 30, pricing: "Free Experiment plan",
    signupUrl: "https://console.mistral.ai/api-keys", notes: "",
  },
  {
    id: "nvidia", name: "NVIDIA NIM", kind: "openai", baseUrl: "https://integrate.api.nvidia.com/v1", keyRequired: true,
    models: ["openai/gpt-oss-120b"], rpm: 40, pricing: "Free developer credits", signupUrl: "https://build.nvidia.com",
    notes: "Verify model ids with Fetch models.",
  },
  {
    id: "cloudflare", name: "Cloudflare Workers AI", kind: "openai",
    baseUrl: "https://api.cloudflare.com/client/v4/accounts/ACCOUNT_ID/ai/v1", keyRequired: true,
    models: ["@cf/meta/llama-3.3-70b-instruct-fp8-fast"], rpm: 60, pricing: "Free daily neuron allowance",
    signupUrl: "https://dash.cloudflare.com", notes: "Replace ACCOUNT_ID in the base URL.",
  },
  {
    id: "zai", name: "Z.AI (GLM)", kind: "openai", baseUrl: "https://api.z.ai/api/paas/v4", keyRequired: true,
    models: ["glm-4.7-flash", "glm-4.5-flash"], rpm: 3, pricing: "Free Flash models", signupUrl: "https://z.ai", notes: "",
  },
  {
    id: "deepseek", name: "DeepSeek", kind: "openai", baseUrl: "https://api.deepseek.com/v1", keyRequired: true,
    models: ["deepseek-chat"], rpm: 60, pricing: "Paid, very low cost", signupUrl: "https://platform.deepseek.com", notes: "",
  },
  {
    id: "sambanova", name: "SambaNova", kind: "openai", baseUrl: "https://api.sambanova.ai/v1", keyRequired: true,
    models: ["Meta-Llama-3.3-70B-Instruct"], rpm: 10, pricing: "Free tier", signupUrl: "https://cloud.sambanova.ai", notes: "",
  },
  {
    id: "ovh", name: "OVHcloud AI Endpoints", kind: "openai", baseUrl: "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1",
    keyRequired: false, models: ["Meta-Llama-3_3-70B-Instruct", "gpt-oss-120b", "Qwen3.8-27B"], rpm: 2,
    pricing: "Keyless 2 RPM per IP; free key raises limits", signupUrl: "https://endpoints.ai.cloud.ovh.net",
    notes: "Works without a key, good last-resort fallback.",
  },
  {
    id: "pollinations", name: "Pollinations (no key)", kind: "openai", baseUrl: "https://text.pollinations.ai/openai",
    keyRequired: false, models: ["openai"], rpm: 10, pricing: "Free, no signup, best effort",
    signupUrl: "https://pollinations.ai", notes: "Anonymous tier; fine for trying the system before adding keys.",
  },
  {
    id: "ollama", name: "Ollama (local)", kind: "openai", baseUrl: "http://127.0.0.1:11434/v1", keyRequired: false,
    models: ["llama3.2"], rpm: 600, pricing: "Free, runs on your hardware", signupUrl: "https://ollama.com",
    notes: "Private and unlimited; quality depends on the local model.",
  },
  {
    id: "custom", name: "Custom OpenAI-compatible", kind: "openai", baseUrl: "", keyRequired: false, models: [],
    rpm: 30, pricing: "", signupUrl: "", notes: "Any /chat/completions endpoint (LM Studio, vLLM, LiteLLM, ...).",
  },
];

// lookup by preset id
export const presetById = (id: string) => PRESETS.find((p) => p.id === id);
