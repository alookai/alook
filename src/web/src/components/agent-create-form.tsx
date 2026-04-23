"use client";

import { useState, useRef } from "react";
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

interface AgentCreateFormProps {
  runtimes: Runtime[];
  defaultRuntimeId?: string;
  modelOptions?: Record<string, string[]>;
  onSave: (data: {
    name: string;
    description: string;
    instructions: string;
    runtime_id: string;
    email_handle?: string;
    runtime_config?: Record<string, unknown>;
    custom_email?: CustomEmailData;
  }) => Promise<boolean>;
  onCancel: () => void;
  saving: boolean;
}

export function AgentCreateForm({
  runtimes,
  defaultRuntimeId = "",
  modelOptions,
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
  const [customEmailData, setCustomEmailData] =
    useState<CustomEmailData | null>(null);
  const customEmailGetDataRef = useRef<(() => CustomEmailData | null) | null>(
    null
  );
  const [model, setModel] = useState("");

  const selectedRuntime = runtimes.find((r) => r.id === runtimeId);
  const providerModels =
    selectedRuntime && modelOptions
      ? (modelOptions[selectedRuntime.provider] ?? [])
      : [];

  const derivedHandle = nameToHandle(name);
  const effectiveHandle = emailHandle || derivedHandle;
  const handleError = getHandleError(effectiveHandle);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await onSave({
      name,
      description,
      instructions,
      runtime_id: runtimeId,
      email_handle: emailHandle || derivedHandle || undefined,
      runtime_config: model ? { model } : {},
      custom_email:
        customEmailGetDataRef.current?.() ?? customEmailData ?? undefined,
    });
  };

  return (
    <div className="flex-1 min-h-0 overflow-y-auto thin-scrollbar px-5 py-6">
      <form onSubmit={handleSubmit} className="mx-auto max-w-md space-y-4">
        <GeneralFields
          name={name}
          setName={setName}
          description={description}
          setDescription={setDescription}
          instructions={instructions}
          setInstructions={setInstructions}
          model={model}
          setModel={setModel}
          runtimeId={runtimeId}
          setRuntimeId={setRuntimeId}
          runtimes={runtimes}
          providerModels={providerModels}
        />

        <div className="border-t border-border/50 pt-4 mt-4 space-y-4">
          <EmailHandleField
            emailHandle={emailHandle}
            setEmailHandle={setEmailHandle}
            derivedHandle={derivedHandle}
          />

          <CustomEmailForm
            workspaceId={workspaceId}
            onDataChange={setCustomEmailData}
            getDataRef={customEmailGetDataRef}
          />
        </div>

        <div className="flex items-center gap-2 pt-2">
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            type="submit"
            size="sm"
            disabled={saving || !name || !!handleError}
          >
            {saving ? "Creating..." : "Create"}
          </Button>
        </div>
      </form>
    </div>
  );
}
