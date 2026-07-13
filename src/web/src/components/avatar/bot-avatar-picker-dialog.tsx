"use client";

import { useEffect, useRef, useState } from "react";
import { Camera } from "lucide-react";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { ImageCropDialog } from "@/components/community/image-crop-dialog";
import { validateIconSourceFile } from "@/lib/community/image-crop";
import { toast } from "sonner";
import {
  type AvatarConfig,
  type AvatarDraft,
  AvatarRenderer,
  DEFAULT_CONFIG,
  parseAvatarUrl,
  serializeAvatarConfig,
} from "./avatar-parts";
import { AvatarGenerator } from "./avatar-generator";
import { useIsMobile } from "@/hooks/use-mobile";

interface BotAvatarPickerDialogProps {
  image: string | null;
  onChange: (draft: AvatarDraft) => void;
}

type PhotoDraft = { file: File | null; previewUrl: string };

/**
 * Dual-mode ("Generate" | "Photo") bot avatar picker. A NEW component —
 * `AvatarPickerDialog` itself is untouched; it's also used by the unrelated
 * workspace-agent feature (`agent-create-form.tsx` / `agent-edit-form.tsx`)
 * on the procedural-only `{ config, onChange }` contract.
 */
export function BotAvatarPickerDialog({ image, onChange }: BotAvatarPickerDialogProps) {
  const [open, setOpen] = useState(false);
  const isMobile = useIsMobile();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [pendingCropSrc, setPendingCropSrc] = useState<{ src: string; fileName: string } | null>(null);

  // `image` can be a persisted URL (http/https/leading-`/`), or — echoed back
  // from this session's own `onChange({ kind: "photo", previewUrl })` — a
  // `blob:` object URL, which `isPhotoAvatarUrl` deliberately doesn't
  // recognize (it's not a value the DB ever stores). Anything that isn't the
  // `avatar:` procedural prefix is a photo here, blob URL included.
  const isPhoto = (url: string | null) => !!url && parseAvatarUrl(url) === null;

  const [tab, setTab] = useState<"generate" | "photo">(isPhoto(image) ? "photo" : "generate");
  const [draftConfig, setDraftConfig] = useState<AvatarConfig>(
    () => parseAvatarUrl(image) ?? DEFAULT_CONFIG,
  );
  const [photoDraft, setPhotoDraft] = useState<PhotoDraft | null>(
    () => (isPhoto(image) ? { file: null, previewUrl: image! } : null),
  );
  // Tracks which draft last won — the active tab decides which one wins on
  // Save, not which one was most recently edited (plan: "whichever tab
  // you're on when you hit Create/Save wins").
  const [activeKind, setActiveKind] = useState<"procedural" | "photo">(
    isPhoto(image) ? "photo" : "procedural",
  );

  // Keeps the trigger-button preview (the "identity anchor") honest when
  // `image` changes from *outside* this component — e.g. the parent
  // randomizing the draft on dialog mount — without waiting for the user to
  // open the inner popup first (that resync only happened in `onOpenChange`
  // below). Idempotent against this component's own `onChange` echoes: the
  // parent hands back exactly the string this component just emitted, so
  // re-parsing it here reproduces the same state.
  useEffect(() => {
    const nowPhoto = isPhoto(image);
    setDraftConfig(parseAvatarUrl(image) ?? DEFAULT_CONFIG);
    setPhotoDraft((prev) =>
      nowPhoto
        ? prev && prev.previewUrl === image
          ? prev
          : { file: null, previewUrl: image! }
        : null,
    );
    setActiveKind(nowPhoto ? "photo" : "procedural");
  }, [image]);

  const emitForTab = (nextTab: "generate" | "photo", config: AvatarConfig, photo: PhotoDraft | null) => {
    if (nextTab === "photo" && photo) {
      setActiveKind("photo");
      onChange({ kind: "photo", file: photo.file, previewUrl: photo.previewUrl });
    } else {
      setActiveKind("procedural");
      onChange({ kind: "procedural", image: serializeAvatarConfig(config) });
    }
  };

  const pickPhoto = () => fileInputRef.current?.click();
  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const check = validateIconSourceFile(file);
    if (!check.ok) {
      toast.error(check.error);
      return;
    }
    setPendingCropSrc({ src: URL.createObjectURL(file), fileName: file.name });
  };

  const triggerPreview = activeKind === "photo" ? photoDraft?.previewUrl : null;

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(nextOpen) => {
          if (nextOpen) {
            const nowPhoto = isPhoto(image);
            const config = parseAvatarUrl(image) ?? DEFAULT_CONFIG;
            setDraftConfig(config);
            if (nowPhoto) {
              // Reopening with the *same* previewUrl this instance already
              // holds (the round-trip through the parent's `avatarDraft`)
              // must not clobber a real `File` back to `null` — only reset
              // when `image` genuinely changed (e.g. first open on an
              // existing persisted photo, or a different URL entirely).
              setPhotoDraft((prev) =>
                prev && prev.previewUrl === image ? prev : { file: null, previewUrl: image! },
              );
            } else {
              setPhotoDraft(null);
            }
            setTab(nowPhoto ? "photo" : "generate");
            setActiveKind(nowPhoto ? "photo" : "procedural");
          }
          setOpen(nextOpen);
        }}
      >
        <div className="flex justify-center">
          <DialogTrigger
            render={
              <button
                type="button"
                className="rounded-2xl bg-background p-2 shadow-sm border border-border hover:border-primary/40 transition-colors cursor-pointer"
              />
            }
          >
            {triggerPreview ? (
              <img src={triggerPreview} alt="" className="size-20 rounded-2xl object-cover" />
            ) : (
              <AvatarRenderer config={draftConfig} size={80} />
            )}
          </DialogTrigger>
        </div>

        <DialogContent className={
          isMobile
            ? "top-auto left-0 translate-x-0 translate-y-0 bottom-0 max-w-full sm:max-w-full w-full rounded-b-none rounded-t-xl max-h-[85dvh] overflow-y-auto thin-scrollbar pb-[env(safe-area-inset-bottom)]"
            : "sm:max-w-180"
        }>
          <DialogHeader>
            <DialogTitle>Choose Avatar</DialogTitle>
          </DialogHeader>
          <Tabs
            value={tab}
            onValueChange={(v) => {
              const nextTab = v as "generate" | "photo";
              setTab(nextTab);
              emitForTab(nextTab, draftConfig, photoDraft);
            }}
          >
            <TabsList className="mx-auto">
              <TabsTrigger value="generate">Generate</TabsTrigger>
              <TabsTrigger value="photo">Photo</TabsTrigger>
            </TabsList>
            <TabsContent value="generate">
              <AvatarGenerator
                config={draftConfig}
                layout={isMobile ? "vertical" : "horizontal"}
                onChange={(next) => {
                  setDraftConfig(next);
                  setActiveKind("procedural");
                  onChange({ kind: "procedural", image: serializeAvatarConfig(next) });
                }}
                mobile={isMobile}
              />
            </TabsContent>
            <TabsContent value="photo">
              <div className="flex flex-col items-center gap-3 py-6">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  className="hidden"
                  onChange={onFileChange}
                />
                <button
                  type="button"
                  onClick={pickPhoto}
                  className="grid size-32 place-items-center overflow-hidden rounded-full border-2 border-dashed border-input text-muted-foreground hover:border-primary hover:text-foreground"
                >
                  {photoDraft ? (
                    <img src={photoDraft.previewUrl} alt="" className="size-full object-cover" />
                  ) : (
                    <Camera className="size-8" />
                  )}
                </button>
                <Button type="button" variant="secondary" size="sm" onClick={pickPhoto}>
                  {photoDraft ? "Change photo" : "Upload Photo"}
                </Button>
              </div>
            </TabsContent>
          </Tabs>
          {isMobile && (
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="w-full rounded-xl bg-primary py-3 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
            >
              Done
            </button>
          )}
        </DialogContent>
      </Dialog>
      {pendingCropSrc && (
        <ImageCropDialog
          imageSrc={pendingCropSrc.src}
          originalFileName={pendingCropSrc.fileName}
          maskShape="circle"
          onCropped={(file) => {
            const previewUrl = URL.createObjectURL(file);
            if (photoDraft?.previewUrl.startsWith("blob:")) {
              URL.revokeObjectURL(photoDraft.previewUrl);
            }
            setPhotoDraft({ file, previewUrl });
            setActiveKind("photo");
            onChange({ kind: "photo", file, previewUrl });
            URL.revokeObjectURL(pendingCropSrc.src);
            setPendingCropSrc(null);
          }}
          onCancel={() => {
            URL.revokeObjectURL(pendingCropSrc.src);
            setPendingCropSrc(null);
          }}
        />
      )}
    </>
  );
}
