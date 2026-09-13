import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  Linking,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import {
  ArrowLeft,
  ChevronRight,
  Download,
  Eye,
  EyeOff,
  File,
  FileArchive,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileSymlink,
  FileText,
  Film,
  Folder,
  FolderPlus,
  Info,
  Music,
  Pencil,
  Presentation,
  RefreshCw,
  Share,
  Upload,
  Trash,
  X,
} from "lucide-react-native";
import * as DocumentPicker from "expo-document-picker";
import { File as ExpoFile, Paths, UploadType } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { VideoView, useVideoPlayer } from "expo-video";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { SvgUri } from "react-native-svg";
import { theme } from "../theme";
import type { RpcClient } from "../lib/client";
import { pushBackHandler } from "../lib/backPress";
import { formatBytes } from "../lib/format";
import {
  authHeaders,
  fileKindFromName,
  formatDateTime,
  isTextPreviewKind,
  kindLabel,
  parentOf,
  previewUrl,
  safeLocalName,
  uploadUrl,
  type ExplorerEntry,
  type FileKind,
  type FileStat,
  type TextPreview,
} from "../lib/files";
import { highlightCode, type HighlightedLine } from "../lib/shiki";

const PAGE_SIZE = 500;
/** Max lines rendered in the text preview (t3code virtualizes; v1 caps). */
const MAX_RENDER_LINES = 2000;

/** NAS-style file browser over `filesystem.*` RPC + `/api/files/*` HTTP. */
export function FilesScreen({ client }: { client: RpcClient | null }) {
  const [path, setPath] = useState<string>("");
  const [entries, setEntries] = useState<ExplorerEntry[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [includeHidden, setIncludeHidden] = useState(false);

  const [actionTarget, setActionTarget] = useState<ExplorerEntry | null>(null);
  const [previewTarget, setPreviewTarget] = useState<ExplorerEntry | null>(null);
  const [mkdirOpen, setMkdirOpen] = useState(false);
  const [mkdirName, setMkdirName] = useState("");
  const [renameTarget, setRenameTarget] = useState<ExplorerEntry | null>(null);
  const [renameName, setRenameName] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<ExplorerEntry | null>(null);
  const [detailsTarget, setDetailsTarget] = useState<ExplorerEntry | null>(null);
  const [mutating, setMutating] = useState(false);
  const [uploading, setUploading] = useState<string | null>(null);

  // System back / edge-swipe: close the topmost dialog first, then walk up
  // one folder; return false at the root so tab-history navigation runs.
  // (Registered after `browse`/`openEntry` below — the handler reads refs.)
  const backState = useRef({ actionTarget, previewTarget, mkdirOpen, renameTarget, deleteTarget, detailsTarget, path });
  backState.current = { actionTarget, previewTarget, mkdirOpen, renameTarget, deleteTarget, detailsTarget, path };

  const profile = client?.profileSnapshot ?? null;

  const browse = useCallback(
    async (p: string, opts?: { hidden?: boolean; offset?: number; append?: boolean }) => {
      if (!client) return;
      const hidden = opts?.hidden ?? includeHidden;
      const offset = opts?.offset ?? 0;
      if (opts?.append) setLoadingMore(true);
      else {
        setBusy(true);
        setError(null);
      }
      try {
        const res = (await client.call("filesystem.browse", {
          path: p,
          includeHidden: hidden,
          limit: PAGE_SIZE,
          offset,
        })) as { parentPath: string; entries: ExplorerEntry[]; totalCount: number; hasMore: boolean };
        setPath(res.parentPath);
        setEntries((prev) => (opts?.append ? [...prev, ...res.entries] : res.entries));
        setTotalCount(res.totalCount);
        setHasMore(res.hasMore);
      } catch (e) {
        if (!opts?.append) setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
        setLoadingMore(false);
      }
    },
    [client, includeHidden],
  );

  useEffect(() => {
    browse("");
  }, [browse]);

  const refresh = useCallback(() => browse(path || ""), [browse, path]);
  const toggleHidden = useCallback(() => {
    const next = !includeHidden;
    setIncludeHidden(next);
    browse(path || "", { hidden: next });
  }, [browse, includeHidden, path]);

  const openEntry = useCallback(
    (e: ExplorerEntry) => {
      if (e.isDirectory) browse(e.fullPath);
      else setPreviewTarget(e);
    },
    [browse],
  );

  const browseRef = useRef(browse);
  browseRef.current = browse;
  useEffect(() => {
    return pushBackHandler(() => {
      const s = backState.current;
      if (s.deleteTarget) { setDeleteTarget(null); return true; }
      if (s.detailsTarget) { setDetailsTarget(null); return true; }
      if (s.renameTarget) { setRenameTarget(null); return true; }
      if (s.mkdirOpen) { setMkdirOpen(false); return true; }
      if (s.previewTarget) { setPreviewTarget(null); return true; }
      if (s.actionTarget) { setActionTarget(null); return true; }
      if (s.path) { void browseRef.current(parentOf(s.path)); return true; }
      return false;
    });
  }, []);

  // -- mutations -----------------------------------------------------------

  const doMkdir = useCallback(async () => {
    if (!client || !mkdirName.trim()) return;
    setMutating(true);
    try {
      const full = `${path.replace(/\/$/, "")}/${mkdirName.trim()}`;
      await client.call("filesystem.mkdir", { path: full });
      setMkdirOpen(false);
      setMkdirName("");
      await browse(path || "");
    } catch (e) {
      Alert.alert("Create folder failed", e instanceof Error ? e.message : String(e));
    } finally {
      setMutating(false);
    }
  }, [client, mkdirName, path, browse]);

  const doRename = useCallback(async () => {
    if (!client || !renameTarget || !renameName.trim()) return;
    setMutating(true);
    try {
      const to = `${parentOf(renameTarget.fullPath).replace(/\/$/, "")}/${renameName.trim()}`;
      await client.call("filesystem.rename", { from: renameTarget.fullPath, to });
      setRenameTarget(null);
      setRenameName("");
      setActionTarget(null);
      await browse(path || "");
    } catch (e) {
      Alert.alert("Rename failed", e instanceof Error ? e.message : String(e));
    } finally {
      setMutating(false);
    }
  }, [client, renameTarget, renameName, path, browse]);

  const doDelete = useCallback(async () => {
    if (!client || !deleteTarget) return;
    setMutating(true);
    try {
      await client.call("filesystem.delete", {
        path: deleteTarget.fullPath,
        recursive: deleteTarget.isDirectory,
      });
      setDeleteTarget(null);
      setActionTarget(null);
      setPreviewTarget(null);
      await browse(path || "");
    } catch (e) {
      Alert.alert("Delete failed", e instanceof Error ? e.message : String(e));
    } finally {
      setMutating(false);
    }
  }, [client, deleteTarget, path, browse]);

  const pickAndUpload = useCallback(async () => {
    if (!profile) return;
    try {
      const picked = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true });
      if (picked.canceled || !picked.assets?.length) return;
      setUploading(`Uploading 1/${picked.assets.length}…`);
      let done = 0;
      let failed = 0;
      for (const asset of picked.assets) {
        try {
          setUploading(`Uploading ${done + 1}/${picked.assets.length}: ${asset.name}`);
          const file = new ExpoFile(asset.uri);
          const result = await file.upload(uploadUrl(profile.baseUrl, path || "/", asset.name), {
            httpMethod: "POST",
            uploadType: UploadType.BINARY_CONTENT,
            headers: authHeaders(profile.token),
            mimeType: asset.mimeType ?? "application/octet-stream",
          });
          if (result.status < 200 || result.status >= 300) throw new Error(`HTTP ${result.status}: ${result.body.slice(0, 200)}`);
          done += 1;
        } catch (e) {
          failed += 1;
          Alert.alert(`Upload failed: ${asset.name}`, e instanceof Error ? e.message : String(e));
        }
      }
      setUploading(null);
      await browse(path || "");
      if (done > 0 && failed === 0) Alert.alert("Upload complete", `${done} file${done === 1 ? "" : "s"} uploaded.`);
    } catch (e) {
      setUploading(null);
      Alert.alert("Upload failed", e instanceof Error ? e.message : String(e));
    }
  }, [profile, path, browse]);

  const downloadEntry = useCallback(
    async (e: ExplorerEntry) => {
      if (!profile) return;
      try {
        setUploading(`Downloading ${e.name}…`);
        const dest = new ExpoFile(Paths.cache, safeLocalName(e.name));
        const url = `${profile.baseUrl.replace(/\/+$/, "")}/api/files/download?path=${encodeURIComponent(e.fullPath)}`;
        await ExpoFile.downloadFileAsync(url, dest, { headers: authHeaders(profile.token), idempotent: true });
        setUploading(null);
        const shared = await (async () => {
          try {
            if (!(await Sharing.isAvailableAsync())) return false;
            await Sharing.shareAsync(dest.uri, { dialogTitle: `Share ${e.name}` });
            return true;
          } catch {
            return false;
          }
        })();
        if (!shared) Alert.alert("Downloaded", `Saved to app cache:\n${dest.uri}`);
      } catch (err) {
        setUploading(null);
        Alert.alert("Download failed", err instanceof Error ? err.message : String(err));
      }
    },
    [profile],
  );

  const openExternal = useCallback(
    (e: ExplorerEntry) => {
      if (!profile) return;
      // OS-level handoff for types without a native in-app renderer
      // (PDF / office docs — anyview adapters are future work).
      void Linking.openURL(previewUrl(profile.baseUrl, profile.token, e.fullPath));
    },
    [profile],
  );

  if (!client || !profile) return <Placeholder label="Connect to browse files" />;

  const canGoUp = path !== "/" && path !== "";

  return (
    <View style={styles.root}>
      <View style={styles.headerRow}>
        <Text style={styles.title}>Files</Text>
        <View style={styles.headerActions}>
          <CircleButton label="Refresh" onPress={refresh}>
            <RefreshCw size={17} color={theme.colors.secondary} />
          </CircleButton>
          <CircleButton label={includeHidden ? "Hide hidden files" : "Show hidden files"} onPress={toggleHidden}>
            {includeHidden ? (
              <Eye size={17} color={theme.colors.link} />
            ) : (
              <EyeOff size={17} color={theme.colors.secondary} />
            )}
          </CircleButton>
          <CircleButton label="New folder" onPress={() => setMkdirOpen(true)}>
            <FolderPlus size={17} color={theme.colors.secondary} />
          </CircleButton>
          <CircleButton label={uploading ? "Working…" : "Upload"} onPress={pickAndUpload}>
            <Upload size={17} color={theme.colors.secondary} />
          </CircleButton>
        </View>
      </View>

      <View style={styles.crumbRow}>
        {canGoUp ? (
          <Pressable
            style={styles.backBtn}
            onPress={() => browse(parentOf(path))}
            accessibilityRole="button"
            accessibilityLabel="Parent folder"
            hitSlop={6}
          >
            <ArrowLeft size={18} color={theme.colors.foreground} />
          </Pressable>
        ) : null}
        <Text style={styles.path} numberOfLines={1}>
          {path || "…"}
        </Text>
      </View>

      {uploading ? <Text style={styles.progress}>{uploading}</Text> : null}

      {busy && entries.length === 0 ? (
        <ActivityIndicator color={theme.colors.foreground} style={{ marginTop: 24 }} />
      ) : error ? (
        <View>
          <Text style={styles.error}>{error}</Text>
          <Pressable style={styles.retryRow} onPress={refresh}>
            <RefreshCw size={16} color={theme.colors.link} />
            <Text style={styles.retryLabel}>Retry</Text>
          </Pressable>
        </View>
      ) : (
        <ScrollView contentContainerStyle={{ paddingBottom: 24 }}>
          <Text style={styles.count}>
            {totalCount} item{totalCount === 1 ? "" : "s"}
            {includeHidden ? " · including hidden" : ""}
          </Text>
          {entries.map((e) => (
            <Pressable key={e.fullPath} onPress={() => openEntry(e)} onLongPress={() => setActionTarget(e)} style={styles.fileRow}>
              <View style={styles.iconWrap}>
                <EntryIcon entry={e} />
              </View>
              <View style={styles.rowBody}>
                <Text style={styles.rowLabel} numberOfLines={1}>
                  {e.name}
                  {e.isSymlink ? " 🔗" : ""}
                </Text>
                <Text style={styles.rowMeta} numberOfLines={1}>
                  {e.isDirectory ? "Folder" : `${kindLabel(fileKindFromName(e.name), false)} · ${formatBytes(e.size)}`} · {formatDateTime(e.mtimeMs)}
                </Text>
              </View>
              {e.isFile ? <Text style={styles.size}>{formatBytes(e.size)}</Text> : <ChevronRight size={18} color={theme.colors.chevron} />}
            </Pressable>
          ))}
          {hasMore ? (
            <Pressable onPress={() => browse(path || "", { offset: entries.length, append: true })} disabled={loadingMore} style={styles.loadMoreRow}>
              <Text style={styles.loadMore}>{loadingMore ? "Loading…" : `Load more (${entries.length}/${totalCount})`}</Text>
            </Pressable>
          ) : null}
          {entries.length === 0 ? <Text style={styles.empty}>Empty folder</Text> : null}
        </ScrollView>
      )}

      {/* action sheet */}
      <Modal visible={actionTarget !== null} transparent animationType="fade" onRequestClose={() => setActionTarget(null)}>
        <Pressable style={styles.sheetBackdrop} onPress={() => setActionTarget(null)}>
          <Pressable style={styles.sheet} onPress={() => {}}>
            <Text style={styles.sheetTitle} numberOfLines={1}>
              {actionTarget?.name}
            </Text>
            <SheetRow label={actionTarget?.isDirectory ? "Open" : "Preview"} icon={<Eye size={17} color={theme.colors.secondary} />} onPress={() => { if (actionTarget) openEntry(actionTarget); setActionTarget(null); }} />
            <SheetRow label="Details" icon={<Info size={17} color={theme.colors.secondary} />} onPress={() => { setDetailsTarget(actionTarget); setActionTarget(null); }} />
            <SheetRow label="Rename" icon={<Pencil size={17} color={theme.colors.secondary} />} onPress={() => { setRenameName(actionTarget?.name ?? ""); setRenameTarget(actionTarget); setActionTarget(null); }} />
            {!actionTarget?.isDirectory ? (
              <>
                <SheetRow label="Download" icon={<Download size={17} color={theme.colors.secondary} />} onPress={() => { if (actionTarget) void downloadEntry(actionTarget); setActionTarget(null); }} />
                <SheetRow label="Open in other app" icon={<Share size={17} color={theme.colors.secondary} />} onPress={() => { if (actionTarget) void downloadEntry(actionTarget); setActionTarget(null); }} />
              </>
            ) : null}
            <SheetRow label="Delete" danger icon={<Trash size={17} color={theme.colors.danger} />} onPress={() => { setDeleteTarget(actionTarget); setActionTarget(null); }} />
            <SheetRow label="Cancel" icon={<X size={17} color={theme.colors.secondary} />} onPress={() => setActionTarget(null)} />
          </Pressable>
        </Pressable>
      </Modal>

      {/* preview */}
      <Modal visible={previewTarget !== null} animationType="slide" onRequestClose={() => setPreviewTarget(null)}>
        {previewTarget && client && profile ? (
          <PreviewScreen
            client={client}
            baseUrl={profile.baseUrl}
            token={profile.token}
            entry={previewTarget}
            onClose={() => setPreviewTarget(null)}
            onDownload={() => void downloadEntry(previewTarget)}
            onOpenExternal={() => openExternal(previewTarget)}
            onDelete={() => setDeleteTarget(previewTarget)}
            onRename={() => {
              setRenameName(previewTarget.name);
              setRenameTarget(previewTarget);
              setPreviewTarget(null);
            }}
          />
        ) : null}
      </Modal>

      {/* details */}
      <DetailsModal client={client} entry={detailsTarget} onClose={() => setDetailsTarget(null)} />

      {/* mkdir */}
      <PromptModal
        visible={mkdirOpen}
        title="New folder"
        placeholder="Folder name"
        value={mkdirName}
        onChange={setMkdirName}
        busy={mutating}
        onCancel={() => setMkdirOpen(false)}
        onSubmit={doMkdir}
      />

      {/* rename */}
      <PromptModal
        visible={renameTarget !== null}
        title={`Rename ${renameTarget?.name ?? ""}`}
        placeholder="New name"
        value={renameName}
        onChange={setRenameName}
        busy={mutating}
        onCancel={() => setRenameTarget(null)}
        onSubmit={doRename}
      />

      {/* delete confirm */}
      <Modal visible={deleteTarget !== null} transparent animationType="fade" onRequestClose={() => setDeleteTarget(null)}>
        <View style={styles.sheetBackdrop}>
          <View style={styles.sheet}>
            <Text style={styles.sheetTitle}>Delete {deleteTarget?.name}?</Text>
            <Text style={styles.deleteWarn}>
              {deleteTarget?.isDirectory
                ? "The folder and everything inside it will be permanently deleted."
                : "This file will be permanently deleted."}
            </Text>
            <View style={styles.modalButtons}>
              <Pressable style={styles.cancelBtn} onPress={() => setDeleteTarget(null)}>
                <Text style={styles.cancelLabel}>Cancel</Text>
              </Pressable>
              <Pressable style={[styles.deleteBtn, mutating && styles.disabledBtn]} onPress={doDelete} disabled={mutating}>
                <Text style={styles.deleteLabel}>{mutating ? "Deleting…" : "Delete"}</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

// -- icons -------------------------------------------------------------------

function EntryIcon({ entry }: { entry: ExplorerEntry }) {
  if (entry.isSymlink && !entry.isDirectory) return <FileSymlink size={19} color={theme.colors.secondary} />;
  if (entry.isDirectory) return <Folder size={19} color={theme.colors.link} />;
  const kind = fileKindFromName(entry.name);
  switch (kind) {
    case "image":
      return <FileImage size={19} color={theme.colors.secondary} />;
    case "video":
      return <Film size={19} color={theme.colors.secondary} />;
    case "audio":
      return <Music size={19} color={theme.colors.secondary} />;
    case "pdf":
      return <FileText size={19} color={theme.colors.danger} />;
    case "office":
      return entry.extension === ".pptx" ? <Presentation size={19} color={theme.colors.secondary} /> : <FileSpreadsheet size={19} color={theme.colors.secondary} />;
    case "archive":
      return <FileArchive size={19} color={theme.colors.secondary} />;
    case "code":
      return <FileCode size={19} color={theme.colors.secondary} />;
    case "markdown":
    case "text":
    case "csv":
    case "ipynb":
      return <FileText size={19} color={theme.colors.secondary} />;
    default:
      return <File size={19} color={theme.colors.secondary} />;
  }
}

// -- preview -----------------------------------------------------------------

/**
 * Type-routed preview. Ports t3code `FilePreviewPanel` branching:
 * media streams over HTTP (`/api/files/preview`, never inlined in RPC),
 * text-likes go through `filesystem.readFile` with Shiki highlighting and
 * a truncation banner, everything else gets metadata + download/share
 * (anyview adapters pending).
 */
function PreviewScreen({
  client,
  baseUrl,
  token,
  entry,
  onClose,
  onDownload,
  onOpenExternal,
  onDelete,
  onRename,
}: {
  client: RpcClient;
  baseUrl: string;
  token: string;
  entry: ExplorerEntry;
  onClose: () => void;
  onDownload: () => void;
  onOpenExternal: () => void;
  onDelete: () => void;
  onRename: () => void;
}) {
  const kind: FileKind = entry.isDirectory ? "binary" : fileKindFromName(entry.name);
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.previewRoot, { paddingTop: insets.top + 8 }]}>
      <View style={styles.previewHeader}>
        <CircleButton label="Close preview" onPress={onClose}>
          <X size={17} color={theme.colors.foreground} />
        </CircleButton>
        <View style={styles.previewTitleWrap}>
          <Text style={styles.previewTitle} numberOfLines={1}>
            {entry.name}
          </Text>
          <Text style={styles.previewSubtitle} numberOfLines={1}>
            {entry.isDirectory ? "Folder" : `${kindLabel(kind, false)} · ${formatBytes(entry.size)}`}
          </Text>
        </View>
        <CircleButton label="Rename" onPress={onRename}>
          <Pencil size={16} color={theme.colors.secondary} />
        </CircleButton>
        <CircleButton label="Download" onPress={onDownload}>
          <Download size={16} color={theme.colors.secondary} />
        </CircleButton>
        <CircleButton label="Delete" onPress={onDelete}>
          <Trash size={16} color={theme.colors.danger} />
        </CircleButton>
      </View>

      {entry.isDirectory ? (
        <View style={styles.centerBox}>
          <Folder size={40} color={theme.colors.link} />
          <Text style={styles.centerText}>Folders open in the browser.</Text>
        </View>
      ) : isTextPreviewKind(kind) ? (
        <TextPreviewView client={client} entry={entry} kind={kind} />
      ) : kind === "image" ? (
        <ImagePreviewView baseUrl={baseUrl} token={token} entry={entry} />
      ) : kind === "video" || kind === "audio" ? (
        <VideoPreviewView baseUrl={baseUrl} token={token} entry={entry} kind={kind} />
      ) : (
        <GenericFileView entry={entry} kind={kind} onDownload={onDownload} onOpenExternal={onOpenExternal} />
      )}
    </View>
  );
}

function TextPreviewView({ client, entry, kind }: { client: RpcClient; entry: ExplorerEntry; kind: FileKind }) {
  const [preview, setPreview] = useState<TextPreview | null>(null);
  const [highlighted, setHighlighted] = useState<HighlightedLine[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setPreview(null);
    setHighlighted(null);
    setError(null);
    (async () => {
      try {
        const res = (await client.call("filesystem.readFile", { path: entry.fullPath })) as TextPreview;
        if (cancelled) return;
        setPreview(res);
        if (!res.isBinary) {
          const h = await highlightCode(res.content, entry.name);
          if (!cancelled) setHighlighted(h);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, entry.fullPath, entry.name]);

  if (error) return <Text style={styles.error}>{error}</Text>;
  if (!preview) return <ActivityIndicator color={theme.colors.foreground} style={{ marginTop: 32 }} />;
  if (preview.isBinary)
    return (
      <View style={styles.centerBox}>
        <File size={40} color={theme.colors.secondary} />
        <Text style={styles.centerText}>Binary file — no text preview. Use Download.</Text>
      </View>
    );
  const hlLines = highlighted?.slice(0, MAX_RENDER_LINES) ?? null;
  const plainLines = hlLines ? null : preview.content.split("\n").slice(0, MAX_RENDER_LINES);
  const totalLines = preview.content.split("\n").length;
  return (
    <ScrollView style={styles.codeScroll} contentContainerStyle={{ paddingBottom: 24 }}>
      {preview.truncated ? (
        <Text style={styles.truncatedBanner}>
          Preview limited to the first {formatBytes(preview.byteLength)} of {formatBytes(preview.size)}. Download for the full file.
        </Text>
      ) : null}
      {kind === "markdown" ? <Text style={styles.kindNote}>Markdown source shown with highlighting.</Text> : null}
      {hlLines
        ? hlLines.map((line, i) => (
            <View key={i} style={styles.codeLine}>
              <Text style={styles.codeNum}>{i + 1}</Text>
              <Text style={styles.codeText}>
                {line.length === 0 ? (
                  " "
                ) : (
                  line.map((tok, j) => (
                    <Text key={j} style={tok.color ? { color: tok.color } : undefined}>
                      {tok.text}
                    </Text>
                  ))
                )}
              </Text>
            </View>
          ))
        : (plainLines ?? []).map((line, i) => (
            <View key={i} style={styles.codeLine}>
              <Text style={styles.codeNum}>{i + 1}</Text>
              <Text style={styles.codeText}>{line || " "}</Text>
            </View>
          ))}
      {totalLines > MAX_RENDER_LINES ? (
        <Text style={styles.truncatedBanner}>… {totalLines - MAX_RENDER_LINES} more lines not rendered.</Text>
      ) : null}
    </ScrollView>
  );
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/**
 * Pinch-to-zoom + pan + double-tap container (no native deps — ScrollView
 * zoom only works on iOS).
 *
 * Deliberately NOT based on `nativeEvent.touches` (unreliable in responder
 * events on some Android builds — the previous implementation never saw
 * two touches). Instead every touchdown is tracked by `identifier` via
 * `onTouchStart`, positions update from `changedTouches` in
 * `onResponderMove`, and fingers are pruned in `onTouchEnd/Cancel`.
 * Two tracked touches scale 1–5x, one touch pans while zoomed,
 * double-tap toggles 1x/2.5x.
 */
function Zoomable({ children }: { children: React.ReactNode }) {
  const [t, setT] = useState({ scale: 1, tx: 0, ty: 0 });
  const r = useRef({
    scale: 1,
    tx: 0,
    ty: 0,
    active: new Map<string, { x: number; y: number }>(),
    peak: 0,
    pinchDist: 0,
    pinchBase: 1,
    panX: 0,
    panY: 0,
    downTime: 0,
    downX: 0,
    downY: 0,
    lastTapTime: 0,
    lastTapX: 0,
    lastTapY: 0,
  });
  const commit = useCallback(() => {
    setT({ scale: r.current.scale, tx: r.current.tx, ty: r.current.ty });
  }, []);

  const pairDist = useCallback((): number => {
    const pts = [...r.current.active.values()];
    if (pts.length < 2 || !pts[0] || !pts[1]) return 0;
    return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
  }, []);

  const applyScale = useCallback(
    (s: number) => {
      r.current.scale = clamp(s, 1, 5);
      if (r.current.scale <= 1) {
        r.current.tx = 0;
        r.current.ty = 0;
      }
      commit();
    },
    [commit],
  );

  return (
    <View
      style={styles.zoomArea}
      onStartShouldSetResponder={() => true}
      onResponderTerminationRequest={() => false}
      onTouchStart={(e) => {
        const now = Date.now();
        for (const touch of e.nativeEvent.changedTouches) {
          r.current.active.set(touch.identifier, { x: touch.pageX, y: touch.pageY });
        }
        r.current.peak = Math.max(r.current.peak, r.current.active.size);
        if (r.current.active.size >= 2) {
          r.current.pinchDist = pairDist();
          r.current.pinchBase = r.current.scale;
        } else {
          const first = e.nativeEvent.changedTouches[0];
          if (first) {
            r.current.downTime = now;
            r.current.downX = first.pageX;
            r.current.downY = first.pageY;
            r.current.panX = first.pageX;
            r.current.panY = first.pageY;
          }
        }
      }}
      onResponderMove={(e) => {
        for (const touch of e.nativeEvent.changedTouches) {
          if (r.current.active.has(touch.identifier)) {
            r.current.active.set(touch.identifier, { x: touch.pageX, y: touch.pageY });
          }
        }
        if (r.current.active.size >= 2) {
          const d = pairDist();
          if (r.current.pinchDist > 0 && d > 0) {
            applyScale(r.current.pinchBase * (d / r.current.pinchDist));
          }
        } else if (r.current.active.size === 1 && r.current.scale > 1) {
          const touch = e.nativeEvent.changedTouches[0];
          if (touch && r.current.active.has(touch.identifier)) {
            const dx = touch.pageX - r.current.panX;
            const dy = touch.pageY - r.current.panY;
            r.current.panX = touch.pageX;
            r.current.panY = touch.pageY;
            const lim = 320 * r.current.scale;
            r.current.tx = clamp(r.current.tx + dx, -lim, lim);
            r.current.ty = clamp(r.current.ty + dy, -lim, lim);
            commit();
          }
        }
      }}
      onTouchEnd={(e) => {
        const now = Date.now();
        let quickTap: { x: number; y: number } | null = null;
        for (const touch of e.nativeEvent.changedTouches) {
          r.current.active.delete(touch.identifier);
          // only single-finger gestures count as taps — a pinch release
          // must never toggle zoom
          if (r.current.active.size === 0 && r.current.peak <= 1) {
            const dt = now - r.current.downTime;
            const moved = Math.hypot(touch.pageX - r.current.downX, touch.pageY - r.current.downY);
            if (dt < 300 && moved < 24) quickTap = { x: touch.pageX, y: touch.pageY };
          }
        }
        if (r.current.active.size < 2) r.current.pinchDist = 0;
        if (r.current.active.size === 1) {
          const remaining = [...r.current.active.values()][0];
          if (remaining) {
            r.current.panX = remaining.x;
            r.current.panY = remaining.y;
          }
        }
        if (quickTap) {
          const gap = now - r.current.lastTapTime;
          const near =
            Math.hypot(quickTap.x - r.current.lastTapX, quickTap.y - r.current.lastTapY) < 48;
          if (gap < 350 && near) {
            // double-tap: toggle zoom
            r.current.lastTapTime = 0;
            applyScale(r.current.scale > 1 ? 1 : 2.5);
          } else {
            r.current.lastTapTime = now;
            r.current.lastTapX = quickTap.x;
            r.current.lastTapY = quickTap.y;
          }
        }
      }}
      onTouchCancel={(e) => {
        for (const touch of e.nativeEvent.changedTouches) {
          r.current.active.delete(touch.identifier);
        }
        if (r.current.active.size === 0) r.current.peak = 0;
        r.current.pinchDist = 0;
      }}
      onResponderRelease={() => {
        r.current.active.clear();
        r.current.peak = 0;
        r.current.pinchDist = 0;
      }}
    >
      <View
        style={[
          styles.zoomContent,
          { transform: [{ scale: t.scale }, { translateX: t.tx }, { translateY: t.ty }] },
        ]}
      >
        {children}
      </View>
    </View>
  );
}

function ImagePreviewView({ baseUrl, token, entry }: { baseUrl: string; token: string; entry: ExplorerEntry }) {
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const uri = previewUrl(baseUrl, token, entry.fullPath);
  const isSvg = entry.extension.toLowerCase() === ".svg";
  const onFail = useCallback(() => {
    setLoading(false);
    setFailed(true);
  }, []);
  return (
    <View style={styles.mediaBox}>
      {loading && !failed ? (
        <View style={styles.mediaLoader}>
          <ActivityIndicator color={theme.colors.foreground} />
        </View>
      ) : null}
      {failed ? (
        <Text style={styles.error}>Could not load image.</Text>
      ) : (
        <Zoomable>
          {isSvg ? (
            // RN Image can't decode SVG — react-native-svg renders it
            // (already a dependency). Auth rides the ?token= query.
            <SvgUri
              uri={uri}
              width="100%"
              height="100%"
              onLoad={() => setLoading(false)}
              onError={onFail}
            />
          ) : (
            <Image
              source={{ uri }}
              style={styles.image}
              resizeMode="contain"
              onLoadStart={() => {
                setLoading(true);
                setFailed(false);
              }}
              onLoadEnd={() => setLoading(false)}
              onError={onFail}
            />
          )}
        </Zoomable>
      )}
    </View>
  );
}

function VideoPreviewView({
  baseUrl,
  token,
  entry,
  kind,
}: {
  baseUrl: string;
  token: string;
  entry: ExplorerEntry;
  kind: FileKind;
}) {
  // expo-video streams over HTTP with Range support (server `sendFile`
  // handles `Range:`), auth via header so no token lands in caches.
  const player = useVideoPlayer(
    { uri: `${baseUrl.replace(/\/+$/, "")}/api/files/preview?path=${encodeURIComponent(entry.fullPath)}`, headers: authHeaders(token) },
    (p) => {
      p.loop = false;
    },
  );
  return (
    <View style={styles.mediaBox}>
      {kind === "audio" ? <Music size={36} color={theme.colors.secondary} /> : null}
      <VideoView player={player} style={kind === "audio" ? styles.audioPlayer : styles.videoPlayer} contentFit="contain" nativeControls />
      <Text style={styles.mediaMeta}>
        {kindLabel(kind, false)} · {formatBytes(entry.size)}
      </Text>
    </View>
  );
}

function GenericFileView({
  entry,
  kind,
  onDownload,
  onOpenExternal,
}: {
  entry: ExplorerEntry;
  kind: FileKind;
  onDownload: () => void;
  onOpenExternal: () => void;
}) {
  const note =
    kind === "pdf"
      ? "PDF renders in your system viewer — open or download it below."
      : kind === "office"
        ? "Office documents (anyview mammoth/SheetJS adapters) aren't rendered in-app yet — open or download it below."
        : kind === "html"
          ? "HTML is offered as a download for safety (no inline sandbox yet)."
          : kind === "archive"
            ? "Archives can't be previewed — download to inspect."
            : "No preview for this type yet — download to view.";
  return (
    <View style={styles.centerBox}>
      <EntryIcon entry={entry} />
      <Text style={styles.centerTitle}>
        {kindLabel(kind, false)} · {formatBytes(entry.size)}
      </Text>
      <Text style={styles.centerText}>{note}</Text>
      <View style={styles.centerButtons}>
        <Pressable style={styles.submitBtn} onPress={onOpenExternal}>
          <Text style={styles.submitLabel}>Open</Text>
        </Pressable>
        <Pressable style={styles.cancelBtn} onPress={onDownload}>
          <Text style={styles.cancelLabel}>Download</Text>
        </Pressable>
      </View>
    </View>
  );
}

// -- details -----------------------------------------------------------------

function DetailsModal({ client, entry, onClose }: { client: RpcClient | null; entry: ExplorerEntry | null; onClose: () => void }) {
  const [stat, setStat] = useState<FileStat | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!client || !entry) {
      setStat(null);
      setError(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = (await client.call("filesystem.stat", { path: entry.fullPath })) as FileStat;
        if (!cancelled) setStat(res);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, entry]);

  return (
    <Modal visible={entry !== null} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.sheetBackdrop}>
        <View style={styles.sheet}>
          <Text style={styles.sheetTitle} numberOfLines={1}>
            {entry?.name ?? ""}
          </Text>
          {error ? (
            <Text style={styles.error}>{error}</Text>
          ) : !stat ? (
            <ActivityIndicator color={theme.colors.foreground} style={{ marginVertical: 12 }} />
          ) : (
            <View style={{ gap: 4 }}>
              <DetailRow k="Type" v={stat.isDirectory ? "Folder" : kindLabel(fileKindFromName(stat.name), false)} />
              <DetailRow k="Path" v={stat.fullPath} />
              <DetailRow k="Size" v={stat.isDirectory ? "—" : formatBytes(stat.size)} />
              <DetailRow k="MIME" v={stat.mimeHint ?? "—"} />
              {stat.extension ? <DetailRow k="Extension" v={stat.extension} /> : null}
              <DetailRow k="Modified" v={formatDateTime(stat.mtimeMs)} />
              <DetailRow k="Created" v={formatDateTime(stat.birthtimeMs)} />
              <DetailRow k="Mode" v={`0${(stat.mode & 0o777).toString(8)}`} />
              <DetailRow k="Symlink" v={stat.isSymlink ? "yes" : "no"} />
            </View>
          )}
          <SheetRow label="Close" icon={<X size={17} color={theme.colors.secondary} />} onPress={onClose} />
        </View>
      </View>
    </Modal>
  );
}

function DetailRow({ k, v }: { k: string; v: string }) {
  return (
    <View style={styles.detailRow}>
      <Text style={styles.detailKey}>{k}</Text>
      <Text style={styles.detailVal} numberOfLines={2}>
        {v}
      </Text>
    </View>
  );
}

// -- small building blocks -----------------------------------------------------

/** Circular icon button in the t3Code top-bar style (dark disc, no label). */
function CircleButton({ label, onPress, children }: { label: string; onPress: () => void; children: React.ReactNode }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={4}
      style={styles.circleBtn}
    >
      {children}
    </Pressable>
  );
}

function SheetRow({ label, icon, onPress, danger }: { label: string; icon: React.ReactNode; onPress: () => void; danger?: boolean }) {
  return (
    <Pressable style={styles.sheetRow} onPress={onPress}>
      {icon}
      <Text style={[styles.sheetLabel, danger && styles.dangerLabel]}>{label}</Text>
    </Pressable>
  );
}

function PromptModal({
  visible,
  title,
  placeholder,
  value,
  onChange,
  busy,
  onCancel,
  onSubmit,
}: {
  visible: boolean;
  title: string;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  busy: boolean;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <View style={styles.sheetBackdrop}>
        <View style={styles.sheet}>
          <Text style={styles.sheetTitle}>{title}</Text>
          <TextInput
            style={styles.input}
            placeholder={placeholder}
            placeholderTextColor={theme.colors.muted}
            value={value}
            onChangeText={onChange}
            autoFocus
            autoCapitalize="none"
            autoCorrect={false}
          />
          <View style={styles.modalButtons}>
            <Pressable style={styles.cancelBtn} onPress={onCancel}>
              <Text style={styles.cancelLabel}>Cancel</Text>
            </Pressable>
            <Pressable style={[styles.submitBtn, busy && styles.disabledBtn]} onPress={onSubmit} disabled={busy}>
              <Text style={styles.submitLabel}>{busy ? "Working…" : "Confirm"}</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

export function Placeholder({ label }: { label: string }) {
  return (
    <View style={styles.root}>
      <Text style={styles.empty}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.colors.screen, padding: 16 },
  title: { color: theme.colors.foreground, fontSize: 26, fontFamily: theme.font.bold, flex: 1 },
  headerRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  headerActions: { flexDirection: "row", alignItems: "center", gap: 10 },
  circleBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: theme.colors.card,
    borderWidth: 1,
    borderColor: theme.colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  crumbRow: { flexDirection: "row", alignItems: "center", gap: 10, marginVertical: 12 },
  backBtn: {
    width: 38,
    height: 38,
    borderRadius: 11,
    borderWidth: 1,
    borderColor: theme.colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  path: { color: theme.colors.secondary, fontSize: 14, fontFamily: theme.font.regular, flex: 1 },
  progress: { color: theme.colors.link, fontSize: 12, fontFamily: theme.font.regular, marginBottom: 8 },
  count: { color: theme.colors.muted, fontSize: 12, fontFamily: theme.font.regular, marginBottom: 4 },
  fileRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 10,
    paddingHorizontal: 2,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
  },
  iconWrap: { marginRight: 12, justifyContent: "center", width: 22, alignItems: "center" },
  rowBody: { flex: 1 },
  rowLabel: { color: theme.colors.foreground, fontSize: 15, fontFamily: theme.font.regular },
  rowMeta: { color: theme.colors.muted, fontSize: 12, fontFamily: theme.font.regular, marginTop: 2 },
  size: { color: theme.colors.secondary, fontSize: 13, fontFamily: theme.font.regular, marginLeft: 8 },
  loadMoreRow: { paddingVertical: 14, alignItems: "center" },
  loadMore: { color: theme.colors.link, fontSize: 14, fontFamily: theme.font.medium },
  retryRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 12 },
  retryLabel: { color: theme.colors.link, fontSize: 14, fontFamily: theme.font.medium },
  error: { color: theme.colors.danger, fontFamily: theme.font.regular, marginTop: 16 },
  empty: { color: theme.colors.muted, fontFamily: theme.font.regular, fontSize: 14, textAlign: "center", marginTop: 48 },
  // sheets & modals
  sheetBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.6)", justifyContent: "flex-end" },
  sheet: { backgroundColor: theme.colors.cardAlt, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 16, gap: 4, borderWidth: 1, borderColor: theme.colors.border },
  sheetTitle: { color: theme.colors.foreground, fontSize: 16, fontFamily: theme.font.bold, marginBottom: 8 },
  sheetRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12 },
  sheetLabel: { color: theme.colors.foreground, fontSize: 15, fontFamily: theme.font.regular },
  dangerLabel: { color: theme.colors.danger },
  deleteWarn: { color: theme.colors.secondary, fontSize: 13, fontFamily: theme.font.regular, marginBottom: 12 },
  deleteBtn: { backgroundColor: theme.colors.danger, borderRadius: 12, paddingHorizontal: 18, paddingVertical: 10 },
  deleteLabel: { color: "#fff", fontSize: 14, fontFamily: theme.font.medium },
  input: { backgroundColor: theme.colors.card, color: theme.colors.foreground, borderRadius: 12, borderWidth: 1, borderColor: theme.colors.border, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15, fontFamily: theme.font.regular, marginBottom: 12 },
  modalButtons: { flexDirection: "row", justifyContent: "flex-end", gap: 10, marginTop: 4 },
  cancelBtn: { borderRadius: 12, paddingHorizontal: 18, paddingVertical: 10, borderWidth: 1, borderColor: theme.colors.border },
  cancelLabel: { color: theme.colors.secondary, fontSize: 14, fontFamily: theme.font.medium },
  submitBtn: { backgroundColor: theme.colors.link, borderRadius: 12, paddingHorizontal: 18, paddingVertical: 10 },
  submitLabel: { color: "#fff", fontSize: 14, fontFamily: theme.font.medium },
  disabledBtn: { opacity: 0.5 },
  detailRow: { flexDirection: "row", gap: 8, paddingVertical: 3 },
  detailKey: { color: theme.colors.muted, fontSize: 13, fontFamily: theme.font.regular, width: 80 },
  detailVal: { color: theme.colors.foreground, fontSize: 13, fontFamily: theme.font.regular, flex: 1 },
  // preview
  previewRoot: { flex: 1, backgroundColor: theme.colors.screen },
  previewHeader: { flexDirection: "row", alignItems: "center", paddingHorizontal: 12, paddingBottom: 8, gap: 8 },
  previewTitleWrap: { flex: 1, marginHorizontal: 4 },
  previewTitle: { color: theme.colors.foreground, fontSize: 16, fontFamily: theme.font.bold },
  previewSubtitle: { color: theme.colors.muted, fontSize: 12, fontFamily: theme.font.regular },
  centerBox: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12, padding: 24 },
  centerTitle: { color: theme.colors.foreground, fontSize: 15, fontFamily: theme.font.medium, textAlign: "center" },
  centerText: { color: theme.colors.secondary, fontSize: 13, fontFamily: theme.font.regular, textAlign: "center" },
  centerButtons: { flexDirection: "row", gap: 10, marginTop: 8 },
  codeScroll: { flex: 1, paddingHorizontal: 12 },
  codeLine: { flexDirection: "row", gap: 8 },
  codeNum: { color: theme.colors.tertiary, fontSize: 12, width: 36, textAlign: "right", fontFamily: theme.font.regular },
  codeText: { color: theme.colors.foreground, fontSize: 12, fontFamily: theme.font.regular, flex: 1 },
  truncatedBanner: { color: theme.colors.muted, fontSize: 12, fontFamily: theme.font.regular, backgroundColor: theme.colors.card, borderRadius: 8, padding: 8, marginVertical: 8 },
  kindNote: { color: theme.colors.muted, fontSize: 12, fontFamily: theme.font.regular, marginBottom: 8 },
  mediaBox: { flex: 1, alignItems: "center", justifyContent: "center", padding: 16, gap: 12 },
  mediaLoader: { position: "absolute", top: 0, bottom: 0, left: 0, right: 0, alignItems: "center", justifyContent: "center" },
  zoomArea: { width: "100%", height: "100%" },
  zoomContent: { width: "100%", height: "100%", alignItems: "center", justifyContent: "center" },
  image: { width: "100%", height: "100%" },
  videoPlayer: { width: "100%", height: 320, backgroundColor: "#000", borderRadius: 12 },
  audioPlayer: { width: "100%", height: 120, backgroundColor: "#000", borderRadius: 12 },
  mediaMeta: { color: theme.colors.muted, fontSize: 12, fontFamily: theme.font.regular },
});
