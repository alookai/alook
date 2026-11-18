import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { useState } from "react"
import { fn } from "storybook/test"
import { Activity, Archive, ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ArrowUpRight, AtSign, Ban, Bell, BellOff, Bookmark, Bot, Box, Brain, Bug, Calendar, CalendarDays, Camera, BarChart3, Check, ChevronDown, ChevronLeft, ChevronRight, ChevronUpIcon, CircleCheck, CircleDot, CircleAlert, PlusCircle, HelpCircle, CircleStop, Code2Icon, Copy, CreditCard, Database, DollarSign, Download, MoreHorizontal, MoreVertical, ExternalLink, Eye, File, FileImage, FileSpreadsheet, FileText, Folder, FolderLock, Gauge, Globe, Hash, Highlighter, HouseIcon, ImageIcon, ImageOff, ImagePlus, Inbox, InfoIcon, KeyRound, ListChevronsUpDown, ListFilter, Loader2, Lock, LockKeyhole, LogOut, Mail, MailWarning, Maximize, Maximize2, MessageSquare, MessageSquareLock, MessagesSquare, Minimize, MinusIcon, Monitor, MonitorDot, Moon, Network, OctagonXIcon, Palette, Pause, Pencil, Pin, Play, Plus, Presentation, RefreshCw, Reply, RocketIcon, RotateCcw, Search, Settings, Share, Shield, Shuffle, Smartphone, Square, Sun, Tag, Terminal, WrapText, Trash2, TriangleAlertIcon, Upload, User, UserMinus, UserPlus, UserRound, Users, UsersRound, Volume1, Volume2, VolumeX, WifiOff, X } from "@/components/icons/lucide"
import { ArchiveRestore, BriefcaseBusinessIcon, Dices, Smile, SmilePlus, FileCode2, FileWarning, FileAudio, FileVideo, Link2, Link2Off, MousePointer2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import * as Select from "@/components/ui/select"
import * as Menu from "@/components/ui/dropdown-menu"
import { MachinePairMessageDiagram } from "@/components/community/machines/machine-pair-message-diagram"

const identities: { name: string; Icon: typeof Activity; animated: boolean; aliases: string }[] = [
  { name: "activity", Icon: Activity, animated: true, aliases: "Activity" },
  { name: "archive", Icon: Archive, animated: true, aliases: "Archive" },
  { name: "archive-arrow-up", Icon: ArchiveRestore, animated: false, aliases: "ArchiveRestore" },
  { name: "arrow-down", Icon: ArrowDown, animated: true, aliases: "ArrowDown" },
  { name: "arrow-left", Icon: ArrowLeft, animated: true, aliases: "ArrowLeft" },
  { name: "arrow-right", Icon: ArrowRight, animated: true, aliases: "ArrowRight" },
  { name: "arrow-up", Icon: ArrowUp, animated: true, aliases: "ArrowUp" },
  { name: "arrow-up-right", Icon: ArrowUpRight, animated: true, aliases: "ArrowUpRight" },
  { name: "at-sign", Icon: AtSign, animated: true, aliases: "AtSign" },
  { name: "ban", Icon: Ban, animated: true, aliases: "Ban" },
  { name: "bell", Icon: Bell, animated: true, aliases: "Bell" },
  { name: "bell-off", Icon: BellOff, animated: true, aliases: "BellOff" },
  { name: "bookmark", Icon: Bookmark, animated: true, aliases: "Bookmark" },
  { name: "bot", Icon: Bot, animated: true, aliases: "Bot" },
  { name: "box", Icon: Box, animated: true, aliases: "Box" },
  { name: "brain", Icon: Brain, animated: true, aliases: "Brain" },
  { name: "briefcase-business", Icon: BriefcaseBusinessIcon, animated: false, aliases: "BriefcaseBusinessIcon" },
  { name: "bug", Icon: Bug, animated: true, aliases: "Bug" },
  { name: "calendar", Icon: Calendar, animated: true, aliases: "Calendar" },
  { name: "calendar-days", Icon: CalendarDays, animated: true, aliases: "CalendarDays" },
  { name: "camera", Icon: Camera, animated: true, aliases: "Camera" },
  { name: "chart-column", Icon: BarChart3, animated: true, aliases: "BarChart3" },
  { name: "check", Icon: Check, animated: true, aliases: "Check, CheckIcon" },
  { name: "chevron-down", Icon: ChevronDown, animated: true, aliases: "ChevronDown, ChevronDownIcon" },
  { name: "chevron-left", Icon: ChevronLeft, animated: true, aliases: "ChevronLeft, ChevronLeftIcon" },
  { name: "chevron-right", Icon: ChevronRight, animated: true, aliases: "ChevronRight, ChevronRightIcon" },
  { name: "chevron-up", Icon: ChevronUpIcon, animated: true, aliases: "ChevronUpIcon" },
  { name: "circle-check", Icon: CircleCheck, animated: true, aliases: "CheckCircle2Icon, CircleCheck, CircleCheckIcon" },
  { name: "circle-dot", Icon: CircleDot, animated: true, aliases: "CircleDot" },
  { name: "circle-exclamation-point", Icon: CircleAlert, animated: true, aliases: "AlertCircle, CircleAlert" },
  { name: "circle-plus", Icon: PlusCircle, animated: true, aliases: "PlusCircle" },
  { name: "circle-question-mark", Icon: HelpCircle, animated: true, aliases: "CircleHelp, HelpCircle" },
  { name: "circle-stop", Icon: CircleStop, animated: true, aliases: "CircleStop" },
  { name: "code-xml", Icon: Code2Icon, animated: true, aliases: "Code2Icon" },
  { name: "copy", Icon: Copy, animated: true, aliases: "Copy" },
  { name: "credit-card", Icon: CreditCard, animated: true, aliases: "CreditCard" },
  { name: "database", Icon: Database, animated: true, aliases: "Database" },
  { name: "dices", Icon: Dices, animated: false, aliases: "Dices" },
  { name: "dollar-sign", Icon: DollarSign, animated: true, aliases: "DollarSign" },
  { name: "download", Icon: Download, animated: true, aliases: "Download" },
  { name: "ellipsis", Icon: MoreHorizontal, animated: true, aliases: "MoreHorizontal" },
  { name: "ellipsis-vertical", Icon: MoreVertical, animated: true, aliases: "MoreVertical" },
  { name: "external-link", Icon: ExternalLink, animated: true, aliases: "ExternalLink" },
  { name: "eye", Icon: Eye, animated: true, aliases: "Eye" },
  { name: "face-slightly-smiling", Icon: Smile, animated: false, aliases: "Smile" },
  { name: "face-slightly-smiling-plus", Icon: SmilePlus, animated: false, aliases: "SmilePlus" },
  { name: "file", Icon: File, animated: true, aliases: "File, FileIcon" },
  { name: "file-code-corner", Icon: FileCode2, animated: false, aliases: "FileCode2" },
  { name: "file-exclamation-point", Icon: FileWarning, animated: false, aliases: "FileWarning" },
  { name: "file-headphone", Icon: FileAudio, animated: false, aliases: "FileAudio" },
  { name: "file-image", Icon: FileImage, animated: true, aliases: "FileImage" },
  { name: "file-play", Icon: FileVideo, animated: false, aliases: "FileVideo" },
  { name: "file-spreadsheet", Icon: FileSpreadsheet, animated: true, aliases: "FileSpreadsheet" },
  { name: "file-text", Icon: FileText, animated: true, aliases: "FileText" },
  { name: "folder", Icon: Folder, animated: true, aliases: "Folder" },
  { name: "folder-lock", Icon: FolderLock, animated: true, aliases: "FolderLock" },
  { name: "gauge", Icon: Gauge, animated: true, aliases: "Gauge" },
  { name: "globe", Icon: Globe, animated: true, aliases: "Globe" },
  { name: "hash", Icon: Hash, animated: true, aliases: "Hash" },
  { name: "highlighter", Icon: Highlighter, animated: true, aliases: "Highlighter" },
  { name: "house", Icon: HouseIcon, animated: true, aliases: "Home, HouseIcon" },
  { name: "image", Icon: ImageIcon, animated: true, aliases: "ImageIcon" },
  { name: "image-off", Icon: ImageOff, animated: true, aliases: "ImageOff" },
  { name: "image-plus", Icon: ImagePlus, animated: true, aliases: "ImagePlus" },
  { name: "inbox", Icon: Inbox, animated: true, aliases: "Inbox" },
  { name: "info", Icon: InfoIcon, animated: true, aliases: "InfoIcon" },
  { name: "key-round", Icon: KeyRound, animated: true, aliases: "KeyRound" },
  { name: "link-2", Icon: Link2, animated: false, aliases: "Link2" },
  { name: "link-2-off", Icon: Link2Off, animated: false, aliases: "Link2Off" },
  { name: "list-chevrons-up-down", Icon: ListChevronsUpDown, animated: true, aliases: "ListChevronsUpDown" },
  { name: "list-filter", Icon: ListFilter, animated: true, aliases: "ListFilter" },
  { name: "loader-circle", Icon: Loader2, animated: true, aliases: "Loader2, Loader2Icon, LoaderCircle, LoaderCircleIcon" },
  { name: "lock", Icon: Lock, animated: true, aliases: "Lock" },
  { name: "lock-keyhole", Icon: LockKeyhole, animated: true, aliases: "LockKeyhole" },
  { name: "log-out", Icon: LogOut, animated: true, aliases: "LogOut" },
  { name: "mail", Icon: Mail, animated: true, aliases: "Mail" },
  { name: "mail-exclamation-point", Icon: MailWarning, animated: true, aliases: "MailWarning" },
  { name: "maximize", Icon: Maximize, animated: true, aliases: "Maximize" },
  { name: "maximize-2", Icon: Maximize2, animated: true, aliases: "Maximize2" },
  { name: "message-square", Icon: MessageSquare, animated: true, aliases: "MessageSquare" },
  { name: "message-square-lock", Icon: MessageSquareLock, animated: true, aliases: "MessageSquareLock" },
  { name: "messages-square", Icon: MessagesSquare, animated: true, aliases: "MessagesSquare" },
  { name: "minimize", Icon: Minimize, animated: true, aliases: "Minimize" },
  { name: "minus", Icon: MinusIcon, animated: true, aliases: "MinusIcon" },
  { name: "monitor", Icon: Monitor, animated: true, aliases: "Monitor" },
  { name: "monitor-dot", Icon: MonitorDot, animated: true, aliases: "MonitorDot" },
  { name: "moon", Icon: Moon, animated: true, aliases: "Moon" },
  { name: "mouse-pointer-2", Icon: MousePointer2, animated: false, aliases: "MousePointer2" },
  { name: "network", Icon: Network, animated: true, aliases: "Network" },
  { name: "octagon-x", Icon: OctagonXIcon, animated: true, aliases: "OctagonXIcon" },
  { name: "palette", Icon: Palette, animated: true, aliases: "Palette" },
  { name: "pause", Icon: Pause, animated: true, aliases: "Pause" },
  { name: "pencil", Icon: Pencil, animated: true, aliases: "Pencil, PencilIcon" },
  { name: "pin", Icon: Pin, animated: true, aliases: "Pin" },
  { name: "play", Icon: Play, animated: true, aliases: "Play" },
  { name: "plus", Icon: Plus, animated: true, aliases: "Plus, PlusIcon" },
  { name: "presentation", Icon: Presentation, animated: true, aliases: "Presentation" },
  { name: "refresh-cw", Icon: RefreshCw, animated: true, aliases: "RefreshCw, RefreshCwIcon" },
  { name: "reply", Icon: Reply, animated: true, aliases: "Reply" },
  { name: "rocket", Icon: RocketIcon, animated: true, aliases: "RocketIcon" },
  { name: "rotate-ccw", Icon: RotateCcw, animated: true, aliases: "RotateCcw, RotateCcwIcon" },
  { name: "search", Icon: Search, animated: true, aliases: "Search" },
  { name: "settings", Icon: Settings, animated: true, aliases: "Settings" },
  { name: "share", Icon: Share, animated: true, aliases: "Share" },
  { name: "shield", Icon: Shield, animated: true, aliases: "Shield" },
  { name: "shuffle", Icon: Shuffle, animated: true, aliases: "Shuffle" },
  { name: "smartphone", Icon: Smartphone, animated: true, aliases: "Smartphone" },
  { name: "square", Icon: Square, animated: true, aliases: "Square" },
  { name: "sun", Icon: Sun, animated: true, aliases: "Sun" },
  { name: "tag", Icon: Tag, animated: true, aliases: "Tag" },
  { name: "terminal", Icon: Terminal, animated: true, aliases: "Terminal, TerminalIcon" },
  { name: "text-wrap", Icon: WrapText, animated: true, aliases: "WrapText" },
  { name: "trash", Icon: Trash2, animated: true, aliases: "Trash2" },
  { name: "triangle-exclamation-point", Icon: TriangleAlertIcon, animated: true, aliases: "TriangleAlertIcon" },
  { name: "upload", Icon: Upload, animated: true, aliases: "Upload" },
  { name: "user", Icon: User, animated: true, aliases: "User" },
  { name: "user-minus", Icon: UserMinus, animated: true, aliases: "UserMinus" },
  { name: "user-plus", Icon: UserPlus, animated: true, aliases: "UserPlus" },
  { name: "user-round", Icon: UserRound, animated: true, aliases: "UserRound" },
  { name: "users", Icon: Users, animated: true, aliases: "Users" },
  { name: "users-round", Icon: UsersRound, animated: true, aliases: "UsersRound" },
  { name: "volume-1", Icon: Volume1, animated: true, aliases: "Volume1" },
  { name: "volume-2", Icon: Volume2, animated: true, aliases: "Volume2" },
  { name: "volume-x", Icon: VolumeX, animated: true, aliases: "VolumeX" },
  { name: "wifi-off", Icon: WifiOff, animated: true, aliases: "WifiOff" },
  { name: "x", Icon: X, animated: true, aliases: "X, XIcon" },
 ]

function IconGallery({ onAction }: { onAction: (name: string) => void }) {
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
      {identities.map(({ name, Icon, animated, aliases }) => (
        <div key={name} data-icon-identity={name} data-animated={animated} className="flex min-w-0 flex-col gap-2">
          <Button variant="outline" className="h-11 gap-4" aria-label={`Preview ${name}`} onClick={() => onAction(name)}>
            <Icon className="size-4" />
            <Icon className="size-6" />
          </Button>
          <span className="wrap-break-word text-sm">{name}</span>
          <span className="text-xs text-muted-foreground">{animated ? "Animated" : "Existing static"}</span>
          <span className="wrap-break-word text-xs text-muted-foreground">{aliases}</span>
        </div>
      ))}
    </div>
  )
}

function IntegratedControls({ onAction }: { onAction: (name: string) => void }) {
  const [busy, setBusy] = useState(true)
  const [choice, setChoice] = useState<string | null>("mentions")
  return (
    <div className="flex max-w-2xl flex-col gap-8">
      <div className="flex flex-wrap items-center gap-4">
        <Button data-testid="icon-trial-action" onClick={() => { setBusy((value) => !value); onAction("Toggle loading") }}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
          {busy ? "Finish task" : "Start task"}
        </Button>
        <Button disabled data-testid="icon-trial-disabled"><Bell className="size-4" />Notifications unavailable</Button>
        <Menu.DropdownMenu>
          <Menu.DropdownMenuTrigger render={<Button variant="outline" />}><Settings className="size-4" />Actions</Menu.DropdownMenuTrigger>
          <Menu.DropdownMenuContent>
            <Menu.DropdownMenuItem onClick={() => onAction("Copy link")}><Copy className="size-4" />Copy link</Menu.DropdownMenuItem>
            <Menu.DropdownMenuItem disabled><UserPlus className="size-4" />Invite unavailable</Menu.DropdownMenuItem>
          </Menu.DropdownMenuContent>
        </Menu.DropdownMenu>
        <Select.Select value={choice} onValueChange={(value) => { setChoice(value); onAction(`Select ${value}`) }}>
          <Select.SelectTrigger><Select.SelectValue /></Select.SelectTrigger>
          <Select.SelectContent>
            <Select.SelectItem value="mentions">Mentions</Select.SelectItem>
            <Select.SelectItem value="all">All messages</Select.SelectItem>
          </Select.SelectContent>
        </Select.Select>
      </div>
      <div className="relative">
        <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input data-testid="icon-trial-search" aria-label="Search icons" placeholder="Click through the icon to focus" className="pl-10" />
      </div>
      <div data-testid="icon-trial-nested-svg"><MachinePairMessageDiagram /></div>
    </div>
  )
}

const meta = {
  title: "Web/Foundations/Icons",
  component: IconGallery,
  tags: ["ai-generated"],
  args: { onAction: fn() },
} satisfies Meta<typeof IconGallery>
export default meta
type Story = StoryObj<typeof meta>
export const AllIdentities: Story = { render: (args) => <IconGallery {...args} /> }
export const Integrated: Story = { render: (args) => <IntegratedControls {...args} /> }
