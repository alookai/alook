"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import type { AgentRuntime as Runtime } from "@alook/shared";
import {
  GeneralFields,
  EmailHandleField,
  nameToHandle,
  getHandleError,
} from "@/components/agent-form-fields";
import {
  CustomEmailForm,
  type CustomEmailData,
} from "@/components/custom-email-form";
import { useWorkspace } from "@/contexts/workspace-context";
import {
  type AvatarConfig,
  AvatarPickerDialog,
  randomConfig,
  serializeAvatarConfig,
} from "@/components/avatar";
import { uniqueNamesGenerator, names } from "unique-names-generator";
import {
  type AgentCreateFieldErrors,
  hasAgentCreateFieldErrors,
  validateAgentCreateRequiredFields,
} from "@/components/agent-create-form-validation";

interface AgentCreateFormProps {
  runtimes: Runtime[];
  defaultRuntimeId?: string;
  modelOptions?: Record<string, string[]>;
  guided?: boolean;
  onTourReady?: (startTour: () => void) => void;
  onSave: (data: {
    name: string;
    description: string;
    instructions: string;
    runtime_id: string;
    email_handle?: string;
    runtime_config?: Record<string, unknown>;
    custom_email?: CustomEmailData;
    avatar_url?: string | null;
  }) => Promise<boolean>;
  onCancel: () => void;
  saving: boolean;
}

// Stable initial config to avoid hydration mismatch (randomConfig uses Math.random)
const INITIAL_AVATAR: AvatarConfig = { shape: "circle", eye: "dots", nose: "dot", bg: 0 };

async function runTour() {
  const waitForElement = (selector: string, timeout = 3000) =>
    new Promise<Element | null>((resolve) => {
      const el = document.querySelector(selector);
      if (el) { resolve(el); return; }
      const ob = new MutationObserver(() => {
        const found = document.querySelector(selector);
        if (found) { ob.disconnect(); resolve(found); }
      });
      ob.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => { ob.disconnect(); resolve(null); }, timeout);
    });

  const el = await waitForElement("#agent-name");
  if (!el) return;

  // Wait for layout to stabilize after navigation
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });

  // Verify element has dimensions (painted)
  if (!el.getBoundingClientRect().height) return;

  const { driver } = await import("driver.js");
  await import("driver.js/dist/driver.css");

  const d = driver({
    showProgress: true,
    animate: true,
    allowClose: true,
    overlayClickBehavior: () => {},
    overlayColor: "black",
    overlayOpacity: 0.4,
    popoverClass: "agent-tour-popover",
    steps: [
      {
        element: "#agent-name",
        popover: {
          title: "Name your agent",
          description: "Give your agent a name — this is how you'll identify it.",
          side: "bottom" as const,
          align: "start" as const,
        },
      },
      {
        element: "#agent-runtime-select",
        disableActiveInteraction: false,
        popover: {
          title: "Choose a runtime",
          description: "Select which machine and provider will run this agent.",
          side: "bottom" as const,
          align: "start" as const,
        },
      },
    ],
  });
  d.drive();
}

export function AgentCreateForm({
  runtimes,
  defaultRuntimeId = "",
  modelOptions,
  guided = false,
  onTourReady,
  onSave,
  onCancel,
  saving,
}: AgentCreateFormProps) {
  const { workspaceId } = useWorkspace();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");
  const [runtimeId, setRuntimeId] = useState(defaultRuntimeId);
  const [emailHandle, setEmailHandle] = useState("");
  const [fieldErrors, setFieldErrors] = useState<AgentCreateFieldErrors>({});
  const [customEmailData, setCustomEmailData] =
    useState<CustomEmailData | null>(null);
  const customEmailGetDataRef = useRef<(() => CustomEmailData | null) | null>(
    null
  );
  const [model, setModel] = useState("");
  const [avatarConfig, setAvatarConfig] = useState<AvatarConfig>(INITIAL_AVATAR);

  // Randomize avatar and name on client mount to avoid hydration mismatch
  const avatarInitialized = useRef(false);
  useEffect(() => {
    if (!avatarInitialized.current) {
      avatarInitialized.current = true;
      setAvatarConfig(randomConfig());
      setName(uniqueNamesGenerator({ dictionaries: [names], length: 1, style: "capital" }));
    }
  }, []);

  const shuffleName = useCallback(() => {
    setName(uniqueNamesGenerator({ dictionaries: [names], length: 1, style: "capital" }));
    setFieldErrors((prev) => ({ ...prev, name: undefined }));
  }, []);

  const selectedRuntime = runtimes.find((r) => r.id === runtimeId);
  const providerModels =
    selectedRuntime && modelOptions
      ? (modelOptions[selectedRuntime.provider] ?? [])
      : [];

  const derivedHandle = nameToHandle(name);
  const effectiveHandle = emailHandle || derivedHandle;
  const handleError = getHandleError(effectiveHandle);

  // Driver.js guided tour for first-time agent creation
  const driverStarted = useRef(false);
  useEffect(() => {
    onTourReady?.(() => runTour());
  }, [onTourReady]);
  useEffect(() => {
    if (!guided || driverStarted.current) return;
    driverStarted.current = true;
    runTour();
  }, [guided]);

  const updateName = (value: string) => {
    setName(value);
    if (fieldErrors.name && value.trim()) {
      setFieldErrors((prev) => ({ ...prev, name: undefined }));
    }
  };

  const updateRuntimeId = (value: string) => {
    const oldProvider = runtimes.find((r) => r.id === runtimeId)?.provider;
    const newProvider = runtimes.find((r) => r.id === value)?.provider;
    setRuntimeId(value);
    if (oldProvider && oldProvider !== newProvider) {
      setModel("");
    }
    if (fieldErrors.runtimeId && value) {
      setFieldErrors((prev) => ({ ...prev, runtimeId: undefined }));
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const nextErrors = validateAgentCreateRequiredFields({ name, runtimeId });
    setFieldErrors(nextErrors);

    if (hasAgentCreateFieldErrors(nextErrors)) {
      return;
    }

    await onSave({
      name: name.trim(),
      description,
      instructions,
      runtime_id: runtimeId,
      email_handle: emailHandle || derivedHandle || undefined,
      runtime_config: model ? { model } : {},
      custom_email:
        customEmailGetDataRef.current?.() ?? customEmailData ?? undefined,
      avatar_url: serializeAvatarConfig(avatarConfig),
    });
  };

  return (
    <div className="flex-1 min-h-0 overflow-y-auto thin-scrollbar">
      <form onSubmit={handleSubmit} noValidate className="mx-auto max-w-md flex flex-col gap-4 px-8 pt-8 pb-6">
        <AvatarPickerDialog
          config={avatarConfig}
          onChange={setAvatarConfig}
        />
        <GeneralFields
          name={name}
          setName={updateName}
          description={description}
          setDescription={setDescription}
          instructions={instructions}
          setInstructions={setInstructions}
          model={model}
          setModel={setModel}
          runtimeId={runtimeId}
          setRuntimeId={updateRuntimeId}
          runtimes={runtimes}
          providerModels={providerModels}
          errors={fieldErrors}
          runtimeAsRadio
          onShuffle={shuffleName}
          emailHandleSlot={
            <EmailHandleField
              emailHandle={emailHandle}
              setEmailHandle={setEmailHandle}
              derivedHandle={derivedHandle}
            />
          }
          advancedSection={
            <CustomEmailForm
              workspaceId={workspaceId}
              onDataChange={setCustomEmailData}
              getDataRef={customEmailGetDataRef}
            />
          }
        />

        <div className="flex items-center gap-2 pt-2">
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            type="submit"
            size="sm"
            disabled={saving || !!handleError}
          >
            {saving ? "Creating..." : "Create"}
          </Button>
        </div>
      </form>
    </div>
  );
}
