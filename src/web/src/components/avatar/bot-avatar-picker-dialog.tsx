"use client";

import { useRef, useState } from "react";
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
import { type AvatarDraft } from "@/lib/avatar/model";
import { GeneratedAvatar } from "./generated-avatar";
import { useIsMobile } from "@/hooks/use-mobile";
import { useAvatarDraftPicker, type AvatarPickerTab } from "./use-avatar-draft-picker";
import { tid } from "@/lib/community/testids";

interface BotAvatarPickerDialogProps {
  image: string | null;
  onChange: (draft: AvatarDraft) => void;
}

/**
 * Dual-mode generated or photo bot avatar picker. Generated choices persist as `avatar:beam:{seed}`.
 */
export function BotAvatarPickerDialog({ image, onChange }: BotAvatarPickerDialogProps) {
  const isMobile = useIsMobile();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [pendingCropSrc, setPendingCropSrc] = useState<{ src: string; fileName: string } | null>(null);
  const picker = useAvatarDraftPicker(image, onChange);

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

  const triggerPreview = picker.activeKind === "photo" ? picker.photoDraft?.previewUrl : null;

  return (
    <>
      <Dialog open={picker.open} onOpenChange={picker.onOpenChange}>
        <div className="flex justify-center">
          <DialogTrigger
            render={
              <button
                type="button"
                aria-label="Choose bot avatar"
                data-testid={tid.botAvatarPickerTrigger}
                className="rounded-full bg-background p-2 shadow-sm border border-border hover:border-primary/40 transition-colors cursor-pointer"
              />
            }
          >
            {triggerPreview ? (
              <img src={triggerPreview} alt="" className="size-20 rounded-full object-cover" />
            ) : (
              <span className="block size-20 overflow-hidden rounded-full">
                <GeneratedAvatar seed={picker.seed} size={80} className="size-full" />
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
            value={picker.tab}
            onValueChange={(v) => {
              picker.selectTab(v as AvatarPickerTab);
            }}
          >
            <TabsList className="mx-auto">
              <TabsTrigger value="generate">Generate</TabsTrigger>
              <TabsTrigger value="photo">Photo</TabsTrigger>
            </TabsList>
            <TabsContent value="generate">
              <div className="flex flex-col items-center gap-3 py-6">
                <span className="block size-32 overflow-hidden rounded-full">
                  <GeneratedAvatar seed={picker.seed} size={128} className="size-full" />
                </span>
                <Button type="button" variant="secondary" size="sm" onClick={picker.shuffle}>
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
                  {picker.photoDraft ? (
                    <img src={picker.photoDraft.previewUrl} alt="" className="size-full object-cover" />
                  ) : (
                    <Camera className="size-8" />
                  )}
                </button>
                <Button type="button" variant="secondary" size="sm" onClick={pickPhoto}>
                  {picker.photoDraft ? "Change photo" : "Upload Photo"}
                </Button>
              </div>
            </TabsContent>
          </Tabs>
          {isMobile && (
            <button
              type="button"
              onClick={picker.close}
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
            if (picker.photoDraft?.previewUrl.startsWith("blob:")) {
              URL.revokeObjectURL(picker.photoDraft.previewUrl);
            }
            picker.selectPhoto({ file, previewUrl });
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
