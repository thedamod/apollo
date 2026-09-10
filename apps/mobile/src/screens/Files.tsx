import React, { useCallback, useEffect, useState } from "react";
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
  ChevronRight,
  CornerUpLeft,
  Download,
  Eye,
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
  FilePlus,
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
import { theme } from "../theme";
import type { RpcClient } from "../lib/client";
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
import { Card } from "../components/Card";

const PAGE_SIZE = 500;
/** Max lines rendered in the text preview (t3code virtualizes; v1 caps). */
const MAX_RENDER_LINES = 2000;

/** Full NAS-style file explorer over `filesystem.*` RPC + `/api/files/*` HTTP. */
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
  const [newTextOpen, setNewTextOpen] = useState(false);
  const [newTextName, setNewTextName] = useState("");
  const [newTextContent, setNewTextContent] = useState("");
  const [mutating, setMutating] = useState(false);
  const [uploading, setUploading] = useState<string | null>(null);

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

  const doCreateTextFile = useCallback(async () => {
    if (!client || !profile || !newTextName.trim()) return;
    setMutating(true);
    try {
      const res = await fetch(uploadUrl(profile.baseUrl, path || "/", newTextName.trim()), {
        method: "POST",
        headers: { ...authHeaders(profile.token), "Content-Type": "text/plain; charset=utf-8" },
        body: newTextContent,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`Upload failed (HTTP ${res.status}) ${body.slice(0, 200)}`);
      }
      setNewTextOpen(false);
      setNewTextName("");
      setNewTextContent("");
      await browse(path || "");
    } catch (e) {
      Alert.alert("Create file failed", e instanceof Error ? e.message : String(e));
    } finally {
      setMutating(false);
    }
  }, [client, profile, newTextName, newTextContent, path, browse]);

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

  return (
    <View style={styles.root}>
      <Text style={styles.title}>Files</Text>
      <Text style={styles.path} numberOfLines={1}>
        {path || "…"}
      </Text>

      <View style={styles.toolbar}>
        <ToolbarButton icon={<RefreshCw size={17} color={theme.colors.secondary} />} label="Refresh" onPress={refresh} />
        <ToolbarButton icon={<Eye size={17} color={includeHidden ? theme.colors.link : theme.colors.secondary} />} label={includeHidden ? "Hiding hidden" : "Show hidden"} onPress={toggleHidden} />
        <ToolbarButton icon={<FolderPlus size={17} color={theme.colors.secondary} />} label="New folder" onPress={() => setMkdirOpen(true)} />
        <ToolbarButton icon={<FilePlus size={17} color={theme.colors.secondary} />} label="New file" onPress={() => setNewTextOpen(true)} />
        <ToolbarButton icon={<Upload size={17} color={theme.colors.secondary} />} label={uploading ? "Working…" : "Upload"} onPress={pickAndUpload} />
      </View>
      {uploading ? <Text style={styles.progress}>{uploading}</Text> : null}

      {busy && entries.length === 0 ? (
        <ActivityIndicator color={theme.colors.foreground} style={{ marginTop: 24 }} />
      ) : error ? (
        <View>
          <Text style={styles.error}>{error}</Text>
          <ToolbarButton icon={<RefreshCw size={17} color={theme.colors.link} />} label="Retry" onPress={refresh} />
        </View>
      ) : (
        <ScrollView contentContainerStyle={{ gap: 8, paddingBottom: 24 }}>
          <Text style={styles.count}>
            {totalCount} item{totalCount === 1 ? "" : "s"}
            {includeHidden ? " · including hidden" : ""}
          </Text>
          {path !== "/" && path !== "" ? (
            <Pressable onPress={() => browse(parentOf(path))}>
              <Card>
                <View style={styles.row}>
                  <View style={styles.iconWrap}>
                    <CornerUpLeft size={19} color={theme.colors.secondary} />
                  </View>
                  <Text style={styles.rowLabel}>Parent folder</Text>
                </View>
              </Card>
            </Pressable>
          ) : null}
          {entries.map((e) => (
            <Pressable key={e.fullPath} onPress={() => openEntry(e)} onLongPress={() => setActionTarget(e)}>
              <Card>
                <View style={styles.row}>
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
                  {!e.isDirectory && <Text style={styles.size}>{formatBytes(e.size)}</Text>}
                  {e.isDirectory && <ChevronRight size={18} color={theme.colors.chevron} />}
                </View>
              </Card>
            </Pressable>
          ))}
          {hasMore ? (
            <Pressable onPress={() => browse(path || "", { offset: entries.length, append: true })} disabled={loadingMore}>
              <Card>
                <Text style={styles.loadMore}>{loadingMore ? "Loading…" : `Load more (${entries.length}/${totalCount})`}</Text>
              </Card>
            </Pressable>
          ) : null}
          {entries.length === 0 ? <Text style={styles.empty}>Empty folder</Text> : null}
        </ScrollView>
      )}
      <Text style={styles.hint}>Tap a folder to open, a file to preview. Long-press for actions.</Text>

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

      {/* new text file */}
      <Modal visible={newTextOpen} animationType="slide" onRequestClose={() => setNewTextOpen(false)}>
        <View style={styles.modalRoot}>
          <Text style={styles.modalTitle}>New file in {path || "/"}</Text>
          <TextInput style={styles.input} placeholder="filename.txt" placeholderTextColor={theme.colors.muted} value={newTextName} onChangeText={setNewTextName} autoCapitalize="none" autoCorrect={false} />
          <TextInput style={[styles.input, styles.codeInput]} placeholder="Contents…" placeholderTextColor={theme.colors.muted} value={newTextContent} onChangeText={setNewTextContent} multiline autoCapitalize="none" autoCorrect={false} />
          <View style={styles.modalButtons}>
            <Pressable style={styles.cancelBtn} onPress={() => setNewTextOpen(false)}>
              <Text style={styles.cancelLabel}>Cancel</Text>
            </Pressable>
            <Pressable style={[styles.submitBtn, mutating && styles.disabledBtn]} onPress={doCreateTextFile} disabled={mutating}>
              <Text style={styles.submitLabel}>{mutating ? "Creating…" : "Create"}</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

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
 * text-likes go through `filesystem.readFile` with a truncation banner,
 * everything else gets metadata + download/share (anyview adapters pending).
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
  return (
    <View style={styles.previewRoot}>
      <View style={styles.previewHeader}>
        <Pressable onPress={onClose} style={styles.headerBtn}>
          <X size={20} color={theme.colors.foreground} />
        </Pressable>
        <View style={styles.previewTitleWrap}>
          <Text style={styles.previewTitle} numberOfLines={1}>
            {entry.name}
          </Text>
          <Text style={styles.previewSubtitle} numberOfLines={1}>
            {entry.isDirectory ? "Folder" : `${kindLabel(kind, false)} · ${formatBytes(entry.size)}`}
          </Text>
        </View>
        <Pressable onPress={onDownload} style={styles.headerBtn}>
          <Download size={19} color={theme.colors.secondary} />
        </Pressable>
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

      <View style={styles.previewFooter}>
        <FooterButton label="Rename" icon={<Pencil size={15} color={theme.colors.secondary} />} onPress={onRename} />
        <FooterButton label="Download" icon={<Download size={15} color={theme.colors.secondary} />} onPress={onDownload} />
        <FooterButton label="Delete" danger icon={<Trash size={15} color={theme.colors.danger} />} onPress={onDelete} />
      </View>
    </View>
  );
}

function TextPreviewView({ client, entry, kind }: { client: RpcClient; entry: ExplorerEntry; kind: FileKind }) {
  const [preview, setPreview] = useState<TextPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = (await client.call("filesystem.readFile", { path: entry.fullPath })) as TextPreview;
        if (!cancelled) setPreview(res);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, entry.fullPath]);

  if (error) return <Text style={styles.error}>{error}</Text>;
  if (!preview) return <ActivityIndicator color={theme.colors.foreground} style={{ marginTop: 32 }} />;
  if (preview.isBinary)
    return (
      <View style={styles.centerBox}>
        <File size={40} color={theme.colors.secondary} />
        <Text style={styles.centerText}>Binary file — no text preview. Use Download.</Text>
      </View>
    );
  const lines = preview.content.split("\n");
  const shown = lines.slice(0, MAX_RENDER_LINES);
  return (
    <ScrollView style={styles.codeScroll} contentContainerStyle={{ paddingBottom: 24 }}>
      {preview.truncated ? (
        <Text style={styles.truncatedBanner}>
          Preview limited to the first {formatBytes(preview.byteLength)} of {formatBytes(preview.size)} (t3code shows the same 1 MiB cap). Download for the full file.
        </Text>
      ) : null}
      {kind === "markdown" ? <Text style={styles.kindNote}>Markdown source shown as plain text.</Text> : null}
      {shown.map((line, i) => (
        <View key={i} style={styles.codeLine}>
          <Text style={styles.codeNum}>{i + 1}</Text>
          <Text style={styles.codeText}>{line || " "}</Text>
        </View>
      ))}
      {lines.length > MAX_RENDER_LINES ? (
        <Text style={styles.truncatedBanner}>… {lines.length - MAX_RENDER_LINES} more lines not rendered.</Text>
      ) : null}
    </ScrollView>
  );
}

function ImagePreviewView({ baseUrl, token, entry }: { baseUrl: string; token: string; entry: ExplorerEntry }) {
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  return (
    <View style={styles.mediaBox}>
      {loading && !failed ? <ActivityIndicator color={theme.colors.foreground} /> : null}
      {failed ? (
        <Text style={styles.error}>Could not load image.</Text>
      ) : (
        <Image
          source={{ uri: previewUrl(baseUrl, token, entry.fullPath) }}
          style={styles.image}
          resizeMode="contain"
          onLoadStart={() => {
            setLoading(true);
            setFailed(false);
          }}
          onLoadEnd={() => setLoading(false)}
          onError={() => {
            setLoading(false);
            setFailed(true);
          }}
        />
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

function ToolbarButton({ icon, label, onPress }: { icon: React.ReactNode; label: string; onPress: () => void }) {
  return (
    <Pressable style={styles.toolBtn} onPress={onPress}>
      {icon}
      <Text style={styles.toolLabel}>{label}</Text>
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

function FooterButton({ label, icon, onPress, danger }: { label: string; icon: React.ReactNode; onPress: () => void; danger?: boolean }) {
  return (
    <Pressable style={styles.footerBtn} onPress={onPress}>
      {icon}
      <Text style={[styles.footerLabel, danger && styles.dangerLabel]}>{label}</Text>
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
  title: { color: theme.colors.foreground, fontSize: 26, fontFamily: theme.font.bold },
  path: { color: theme.colors.secondary, fontSize: 13, fontFamily: theme.font.regular, marginVertical: 8 },
  toolbar: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 8 },
  toolBtn: { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: theme.colors.card, borderRadius: 12, paddingHorizontal: 10, paddingVertical: 8, borderWidth: 1, borderColor: theme.colors.border },
  toolLabel: { color: theme.colors.secondary, fontSize: 12, fontFamily: theme.font.regular },
  progress: { color: theme.colors.link, fontSize: 12, fontFamily: theme.font.regular, marginBottom: 8 },
  count: { color: theme.colors.muted, fontSize: 12, fontFamily: theme.font.regular, marginBottom: 4 },
  row: { flexDirection: "row", alignItems: "center" },
  iconWrap: { marginRight: 10, justifyContent: "center" },
  rowBody: { flex: 1 },
  rowLabel: { color: theme.colors.foreground, fontSize: 15, fontFamily: theme.font.regular },
  rowMeta: { color: theme.colors.muted, fontSize: 12, fontFamily: theme.font.regular, marginTop: 2 },
  size: { color: theme.colors.secondary, fontSize: 13, fontFamily: theme.font.regular, marginLeft: 8 },
  loadMore: { color: theme.colors.link, fontSize: 14, fontFamily: theme.font.medium, textAlign: "center" },
  error: { color: theme.colors.danger, fontFamily: theme.font.regular, marginTop: 16 },
  empty: { color: theme.colors.muted, fontFamily: theme.font.regular, fontSize: 14, textAlign: "center", marginTop: 48 },
  hint: { color: theme.colors.tertiary, fontSize: 11, fontFamily: theme.font.regular, textAlign: "center", paddingVertical: 8 },
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
  modalRoot: { flex: 1, backgroundColor: theme.colors.screen, padding: 16, paddingTop: 64 },
  modalTitle: { color: theme.colors.foreground, fontSize: 18, fontFamily: theme.font.bold, marginBottom: 12 },
  input: { backgroundColor: theme.colors.card, color: theme.colors.foreground, borderRadius: 12, borderWidth: 1, borderColor: theme.colors.border, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15, fontFamily: theme.font.regular, marginBottom: 12 },
  codeInput: { minHeight: 200, textAlignVertical: "top", fontSize: 13 },
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
  previewRoot: { flex: 1, backgroundColor: theme.colors.screen, paddingTop: 48 },
  previewHeader: { flexDirection: "row", alignItems: "center", paddingHorizontal: 12, paddingBottom: 8, gap: 8 },
  headerBtn: { padding: 8 },
  previewTitleWrap: { flex: 1 },
  previewTitle: { color: theme.colors.foreground, fontSize: 16, fontFamily: theme.font.bold },
  previewSubtitle: { color: theme.colors.muted, fontSize: 12, fontFamily: theme.font.regular },
  previewFooter: { flexDirection: "row", justifyContent: "space-around", paddingVertical: 12, borderTopWidth: 1, borderTopColor: theme.colors.border },
  footerBtn: { flexDirection: "row", alignItems: "center", gap: 6, padding: 8 },
  footerLabel: { color: theme.colors.secondary, fontSize: 13, fontFamily: theme.font.medium },
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
  image: { width: "100%", height: "100%" },
  videoPlayer: { width: "100%", height: 320, backgroundColor: "#000", borderRadius: 12 },
  audioPlayer: { width: "100%", height: 120, backgroundColor: "#000", borderRadius: 12 },
  mediaMeta: { color: theme.colors.muted, fontSize: 12, fontFamily: theme.font.regular },
});
