import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { Field, FieldLabel, FieldDescription, FieldError, FieldGroup, FieldSet, FieldLegend, FieldContent, FieldTitle, FieldSeparator } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"

function ProfileFields({ invalid = false, disabled = false }: { invalid?: boolean; disabled?: boolean }) {
  return <FieldSet disabled={disabled} className="max-w-lg"><FieldLegend>Profile</FieldLegend><FieldGroup><Field data-invalid={invalid}><FieldLabel htmlFor="profile-name">Display name</FieldLabel><Input id="profile-name" defaultValue="Gus" disabled={disabled} aria-invalid={invalid} /><FieldDescription>Shown to other members.</FieldDescription>{invalid && <FieldError errors={[{ message: "This name is already in use." }]} />}</Field><Field><FieldLabel htmlFor="profile-about">About me</FieldLabel><Textarea id="profile-about" placeholder="A few words about you" disabled={disabled} /></Field><FieldSeparator>Preferences</FieldSeparator><Field orientation="horizontal"><FieldContent><FieldTitle>Notifications</FieldTitle><FieldDescription>Show desktop message alerts.</FieldDescription></FieldContent><Switch aria-label="Notifications" disabled={disabled} /></Field><Label htmlFor="profile-extra">Optional note</Label><Input id="profile-extra" disabled={disabled} /></FieldGroup></FieldSet>
}
const meta = { title: "Web/Foundations/Form fields", component: ProfileFields, tags: ["autodocs", "ai-generated"], args: { invalid: false, disabled: false } } satisfies Meta<typeof ProfileFields>
export default meta
type Story = StoryObj<typeof meta>
export const Profile: Story = {}
export const Invalid: Story = { args: { invalid: true } }
export const Disabled: Story = { args: { disabled: true } }
