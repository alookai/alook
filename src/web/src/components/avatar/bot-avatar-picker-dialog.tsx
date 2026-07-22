"use client";

import { useEffect, useRef, useState } from "react";
import { Camera, Shuffle } from "lucide-react";
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
import { type AvatarDraft, isPhotoAvatarUrl } from "./photo";
import { BoringAvatar } from "./boring-avatar";
import { serializeBeamSeed, parseBeamSeed } from "@/lib/avatar/seed-url";
import { useIsMobile } from "@/hooks/use-mobile";

interface BotAvatarPickerDialogProps {
  image: string | null;
  onChange: (draft: AvatarDraft) => void;
}

type PhotoDraft = { file: File | null; previewUrl: string };

function randomSeed(): string {
  return crypto.randomUUID();
}

/**
 * Dual-mode ("Generate" | "Photo") bot avatar picker. "Generate" is a beam
 * avatar with a shuffle button (boring-avatars has no editable model); the
 * chosen seed persists as `avatar:beam:{seed}`. `AvatarPickerDialog` (the
 * workspace-agent picker) is the single-mode variant.
 */
export function BotAvatarPickerDialog({ image, onChange }: BotAvatarPickerDialogProps) {
  const [open, setOpen] = useState(false);
  const isMobile = useIsMobile();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [pendingCropSrc, setPendingCropSrc] = useState<{ src: string; fileName: string } | null>(null);

  // A photo is anything that's a real URL (http/https/leading-`/`) or a
  // session-local `blob:` preview — NOT a `avatar:beam:{seed}` value, which is
  // the procedural (generated) case.
  const isPhoto = (url: string | null) => !!url && !parseBeamSeed(url) && (isPhotoAvatarUrl(url) || url.startsWith("blob:"));

  const [tab, setTab] = useState<"generate" | "photo">(isPhoto(image) ? "photo" : "generate");
  const [seed, setSeed] = useState<string>(() => parseBeamSeed(image) ?? randomSeed());
  const [photoDraft, setPhotoDraft] = useState<PhotoDraft | null>(
    () => (isPhoto(image) ? { file: null, previewUrl: image! } : null),
  );
  const [activeKind, setActiveKind] = useState<"procedural" | "photo">(
    isPhoto(image) ? "photo" : "procedural",
  );

  // Keep the trigger preview honest when `image` changes from outside this
  // component. Idempotent against this component's own `onChange` echoes.
  useEffect(() => {
    const nowPhoto = isPhoto(image);
    setSeed(parseBeamSeed(image) ?? randomSeed());
    setPhotoDraft((prev) =>
      nowPhoto
        ? prev && prev.previewUrl === image
          ? prev
          : { file: null, previewUrl: image! }
        : null,
    );
    setActiveKind(nowPhoto ? "photo" : "procedural");
  }, [image]);

  const shuffle = () => {
    const next = randomSeed();
    setSeed(next);
    setActiveKind("procedural");
    onChange({ kind: "procedural", image: serializeBeamSeed(next) });
  };

  const emitForTab = (nextTab: "generate" | "photo", currentSeed: string, photo: PhotoDraft | null) => {
    if (nextTab === "photo" && photo) {
      setActiveKind("photo");
      onChange({ kind: "photo", file: photo.file, previewUrl: photo.previewUrl });
    } else {
      setActiveKind("procedural");
      onChange({ kind: "procedural", image: serializeBeamSeed(currentSeed) });
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
            setSeed(parseBeamSeed(image) ?? randomSeed());
            if (nowPhoto) {
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
              <span className="block size-20 overflow-hidden rounded-2xl">
                <BoringAvatar seed={seed} size={80} className="size-full" />
              </span>
            )}
          </DialogTrigger>
        </div>

        <DialogContent className={
          isMobile
            ? "top-auto left-0 translate-x-0 translate-y-0 bottom-0 max-w-full sm:max-w-full w-full rounded-b-none rounded-t-xl max-h-[85dvh] overflow-y-auto thin-scrollbar pb-[env(safe-area-inset-bottom)]"
            : "sm:max-w-120"
        }>
          <DialogHeader>
            <DialogTitle>Choose Avatar</DialogTitle>
          </DialogHeader>
          <Tabs
            value={tab}
            onValueChange={(v) => {
              const nextTab = v as "generate" | "photo";
              setTab(nextTab);
              emitForTab(nextTab, seed, photoDraft);
            }}
          >
            <TabsList className="mx-auto">
              <TabsTrigger value="generate">Generate</TabsTrigger>
              <TabsTrigger value="photo">Photo</TabsTrigger>
            </TabsList>
            <TabsContent value="generate">
              <div className="flex flex-col items-center gap-3 py-6">
                <span className="block size-32 overflow-hidden rounded-full">
                  <BoringAvatar seed={seed} size={128} className="size-full" />
                </span>
                <Button type="button" variant="secondary" size="sm" onClick={shuffle}>
                  <Shuffle className="size-3.5" />
                  Shuffle
                </Button>
              </div>
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
