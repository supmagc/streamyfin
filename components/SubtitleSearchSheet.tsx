import { Ionicons } from "@expo/vector-icons";
import {
  BottomSheetBackdrop,
  type BottomSheetBackdropProps,
  BottomSheetModal,
  BottomSheetScrollView,
} from "@gorhom/bottom-sheet";
import type {
  BaseItemDto,
  MediaStream,
} from "@jellyfin/sdk/lib/generated-client/models";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ActivityIndicator,
  Alert,
  StyleSheet,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Text } from "@/components/common/Text";
import {
  type SubtitleSearchResult,
  useRemoteSubtitles,
} from "@/hooks/useRemoteSubtitles";
import { useSheetOpenState } from "@/hooks/useSheetOpenState";
import { useDownload } from "@/providers/DownloadProvider";
import {
  burnedInSubtitle,
  changeDownloadSubtitles,
  downloadSubtitleFiles,
  isLocalSubtitle,
  removeSubtitleFromDownload,
} from "@/providers/Downloads/subtitles";
import { apiAtom, userAtom } from "@/providers/JellyfinProvider";
import { useSettings } from "@/utils/atoms/settings";
import {
  deleteServerSubtitle,
  fetchServerStreams,
  sidecarSubtitles,
} from "@/utils/jellyfin/serverSubtitles";
import {
  canDeleteServerSubtitles,
  subtitleSearchErrorMessage,
} from "@/utils/jellyfin/subtitleSearchAccess";
import {
  defaultSubtitleSearchLanguage,
  subtitleSearchLanguages,
} from "@/utils/opensubtitles/api";
import { type OptionGroup, PlatformDropdown } from "./PlatformDropdown";

interface Props {
  open: boolean;
  setOpen: (open: boolean) => void;
  item: BaseItemDto;
  mediaSourceId?: string | null;
  /** A subtitle the server saved, numbered as the item will be once it reloads. */
  onSaved?: (stream: MediaStream) => void;
}

/**
 * Searches for subtitles for an item and lists the subtitle files it has.
 *
 * Streamed, only the server's results are offered, saved next to the item: outside a playback a
 * file kept on the device would not be played. An administrator can delete the item's files.
 *
 * Downloaded, a result the server saves reaches the download through the sync, and an
 * OpenSubtitles one, for when the server cannot save it, goes into the download only. The
 * download's files can be removed from it, and an administrator can delete the server's from the
 * library too.
 */
export const SubtitleSearchSheet: React.FC<Props> = ({
  open,
  setOpen,
  item,
  mediaSourceId,
  onSaved,
}) => {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const api = useAtomValue(apiAtom);
  const user = useAtomValue(userAtom);
  const { settings } = useSettings();
  const queryClient = useQueryClient();
  const { downloadedItems, syncSubtitles, takeServerSubtitle, triggerRefresh } =
    useDownload();
  const sheetRef = useRef<BottomSheetModal>(null);
  const snapPoints = useMemo(() => ["75%"], []);

  // Only a language picked in this opening is kept: the user's own can come in
  // from their profile or the plugin after the page mounted the sheet.
  const [pickedLanguage, setLanguage] = useState<string | null>(null);
  const language = pickedLanguage ?? defaultSubtitleSearchLanguage(settings);
  useEffect(() => {
    if (!open) setLanguage(null);
  }, [open]);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [deletingIndex, setDeletingIndex] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const itemId = item.Id ?? "";
  const downloaded = useMemo(
    () => downloadedItems.find((d) => d.item.Id === itemId),
    [downloadedItems, itemId],
  );
  const burnedIn = downloaded && burnedInSubtitle(downloaded);
  const canDelete = canDeleteServerSubtitles(user);
  const {
    hasOpenSubtitlesApiKey,
    isSearching,
    searchError,
    searchResults,
    search,
    downloadAsync,
  } = useRemoteSubtitles({
    itemId,
    item,
    mediaSourceId: downloaded?.mediaSource.Id ?? mediaSourceId,
    intoDownload: !!downloaded,
  });

  const handleDismissed = useSheetOpenState(sheetRef, open);

  useEffect(() => {
    if (!open) return;
    setMessage(null);
    search({ language, serverOnly: !downloaded });
  }, [open, language, search, downloaded]);

  const target = useMemo(
    () => ({
      itemId,
      userId: user?.Id,
      mediaSourceId: downloaded?.mediaSource.Id ?? mediaSourceId,
    }),
    [itemId, user?.Id, downloaded, mediaSourceId],
  );

  const { data: serverFiles, refetch: refetchFiles } = useQuery({
    queryKey: ["subtitle-files", itemId, target.mediaSourceId],
    queryFn: async () => {
      if (!api) return [];
      return sidecarSubtitles((await fetchServerStreams(api, target)) ?? []);
    },
    enabled: open && !downloaded && canDelete && !!api && !!itemId,
  });
  const files = downloaded
    ? downloadSubtitleFiles(downloaded)
    : canDelete
      ? serverFiles
      : undefined;

  const handleSave = useCallback(
    async (result: SubtitleSearchResult) => {
      setSavingId(result.id);
      setMessage(null);
      try {
        const saved = await downloadAsync(result);
        if (saved.type === "download") {
          triggerRefresh();
          setOpen(false);
          return;
        }
        if (saved.type !== "server") return;
        if (downloaded) await takeServerSubtitle(itemId, saved.stream);
        // Before the reload, so the page selects it in the new numbering.
        if (saved.stream) onSaved?.(saved.stream);
        await queryClient.invalidateQueries({ queryKey: ["item", itemId] });
        if (saved.stream) {
          setOpen(false);
        } else if (downloaded && !burnedIn) {
          setMessage(t("player.subtitle_saved_pending_download"));
        } else {
          setMessage(t("player.subtitle_saved_pending"));
        }
      } catch {
        setMessage(t("player.subtitle_save_failed"));
      } finally {
        setSavingId(null);
      }
    },
    [
      downloadAsync,
      downloaded,
      burnedIn,
      itemId,
      takeServerSubtitle,
      triggerRefresh,
      onSaved,
      queryClient,
      setOpen,
      t,
    ],
  );

  const deleteFromLibrary = useCallback(
    async (stream: MediaStream) => {
      if (!api) return;
      setDeletingIndex(stream.Index ?? null);
      setMessage(null);
      try {
        const deleted = await deleteServerSubtitle(api, { ...target, stream });
        if (!deleted) setMessage(t("player.subtitle_delete_failed"));
        // The sync takes it out of the download once the server no longer has it.
        if (downloaded) await syncSubtitles([itemId]);
        await queryClient.invalidateQueries({ queryKey: ["item", itemId] });
        if (!downloaded) await refetchFiles();
      } catch {
        setMessage(t("player.subtitle_delete_failed"));
      } finally {
        setDeletingIndex(null);
      }
    },
    [
      api,
      target,
      downloaded,
      syncSubtitles,
      queryClient,
      itemId,
      refetchFiles,
      t,
    ],
  );

  const removeFromDownload = useCallback(
    async (stream: MediaStream) => {
      setDeletingIndex(stream.Index ?? null);
      setMessage(null);
      try {
        await changeDownloadSubtitles(itemId, (current) =>
          removeSubtitleFromDownload(current, stream),
        );
        triggerRefresh();
      } finally {
        setDeletingIndex(null);
      }
    },
    [itemId, triggerRefresh],
  );

  const confirmDelete = useCallback(
    (stream: MediaStream) => {
      if (!downloaded) {
        Alert.alert(
          t("player.delete_subtitle_title"),
          t("player.delete_subtitle_message"),
          [
            { text: t("common.cancel"), style: "cancel" },
            {
              text: t("common.delete"),
              style: "destructive",
              onPress: () => void deleteFromLibrary(stream),
            },
          ],
        );
        return;
      }
      // A file from OpenSubtitles is only on the device. Without the server,
      // a library file can only leave the download, which keeps it out.
      const fromLibrary = canDelete && !isLocalSubtitle(downloaded, stream);
      Alert.alert(
        t("player.remove_subtitle_title"),
        fromLibrary ? t("player.remove_subtitle_message") : undefined,
        [
          { text: t("common.cancel"), style: "cancel" },
          {
            text: t("player.remove_from_download"),
            style: fromLibrary ? "default" : "destructive",
            onPress: () => void removeFromDownload(stream),
          },
          ...(fromLibrary
            ? [
                {
                  text: t("player.delete_from_library"),
                  style: "destructive" as const,
                  onPress: () => void deleteFromLibrary(stream),
                },
              ]
            : []),
        ],
      );
    },
    [downloaded, canDelete, deleteFromLibrary, removeFromDownload, t],
  );

  const handleSheetChanges = useCallback(
    (index: number) => {
      if (index === -1) setOpen(false);
    },
    [setOpen],
  );

  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop
        {...props}
        disappearsOnIndex={-1}
        appearsOnIndex={0}
      />
    ),
    [],
  );

  const busy = savingId !== null || deletingIndex !== null;

  const [languageMenuOpen, setLanguageMenuOpen] = useState(false);
  const languages = useMemo(
    () => subtitleSearchLanguages(settings),
    [settings],
  );
  const languageName =
    languages.find((l) => l.code === language)?.name ?? language.toUpperCase();
  const languageGroups: OptionGroup[] = useMemo(
    () => [
      {
        options: languages.map((l) => ({
          type: "radio" as const,
          label: l.name,
          value: l.code,
          selected: l.code === language,
          onPress: () => setLanguage(l.code),
        })),
      },
    ],
    [languages, language],
  );

  return (
    <BottomSheetModal
      ref={sheetRef}
      onDismiss={handleDismissed}
      index={0}
      snapPoints={snapPoints}
      onChange={handleSheetChanges}
      backdropComponent={renderBackdrop}
      handleIndicatorStyle={{ backgroundColor: "white" }}
      backgroundStyle={{ backgroundColor: SHEET_BACKGROUND }}
    >
      <BottomSheetScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{
          paddingLeft: Math.max(20, insets.left),
          paddingRight: Math.max(20, insets.right),
          paddingTop: 8,
          paddingBottom: insets.bottom + 24,
        }}
      >
        {/* Laid out like the player's own search sheet. */}
        <View className='flex-row items-center justify-between mb-4'>
          <Text className='text-lg font-bold'>
            {t("player.search_subtitles")}
          </Text>
          <PlatformDropdown
            groups={languageGroups}
            title={t("player.language")}
            open={languageMenuOpen}
            onOpenChange={setLanguageMenuOpen}
            disabled={busy}
            trigger={
              <TouchableOpacity
                onPress={() => setLanguageMenuOpen(true)}
                disabled={busy}
                className='flex-row items-center rounded-xl px-3 py-1.5'
                style={{ backgroundColor: "rgba(255,255,255,0.1)" }}
              >
                <Ionicons name='globe-outline' size={14} color='white' />
                <Text className='text-[13px] font-semibold mx-1'>
                  {languageName}
                </Text>
                <Ionicons name='chevron-down' size={14} color='white' />
              </TouchableOpacity>
            }
          />
        </View>

        {burnedIn && (
          <Text className='text-orange-400 text-[13px] mb-3'>
            {t("player.subtitle_burned_in_warning")}
          </Text>
        )}

        {message && (
          <Text className='text-orange-400 text-[13px] mb-3'>{message}</Text>
        )}

        {isSearching ? (
          <View className='items-center justify-center' style={{ height: 180 }}>
            <ActivityIndicator size='large' color={ACCENT} />
          </View>
        ) : searchError ? (
          <View
            className='items-center justify-center px-8'
            style={{ height: 160 }}
          >
            <Ionicons name='warning-outline' size={32} color={SECONDARY} />
            <Text className='font-semibold mt-2.5'>
              {t("player.search_failed")}
            </Text>
            <Text
              className='text-xs text-center mt-1'
              style={{ color: SECONDARY }}
            >
              {subtitleSearchErrorMessage(
                searchError,
                !!downloaded && hasOpenSubtitlesApiKey,
                t,
              )}
            </Text>
          </View>
        ) : !searchResults?.length ? (
          <View className='items-center justify-center' style={{ height: 140 }}>
            <Ionicons
              name='chatbox-ellipses-outline'
              size={32}
              color={SECONDARY}
            />
            <Text className='font-semibold mt-2.5'>
              {t("player.no_subtitles_found")}
            </Text>
          </View>
        ) : (
          <View style={{ gap: 10 }}>
            {searchResults.map((result) => (
              <TouchableOpacity
                key={result.id}
                onPress={() => handleSave(result)}
                disabled={busy}
                className='flex-row items-center p-3'
                style={styles.card}
              >
                <View className='flex-1 mr-3'>
                  <Text numberOfLines={2} className='text-[13px] font-medium'>
                    {result.name}
                  </Text>
                  <View
                    className='flex-row items-center mt-1'
                    style={{ gap: 6 }}
                  >
                    <Text className='text-[11px]' style={{ color: SECONDARY }}>
                      {result.providerName}
                    </Text>
                    {result.isHashMatch && (
                      <Badge
                        label={t("player.subtitle_match")}
                        color={ACCENT}
                        background='rgba(147,52,233,0.25)'
                      />
                    )}
                    {result.hearingImpaired && (
                      <Badge
                        label={t("player.subtitle_sdh")}
                        color='white'
                        background='rgba(255,255,255,0.15)'
                      />
                    )}
                  </View>
                </View>
                {savingId === result.id ? (
                  <ActivityIndicator size='small' color={ACCENT} />
                ) : (
                  <Ionicons name='download-outline' size={22} color={ACCENT} />
                )}
              </TouchableOpacity>
            ))}
          </View>
        )}

        {!!files?.length && (
          <View className='mt-6' style={{ gap: 10 }}>
            <Text className='font-semibold'>{t("player.subtitle_files")}</Text>
            {files.map((file) => (
              <View
                key={file.Path ?? file.Index}
                className='flex-row items-center p-3'
                style={styles.card}
              >
                <Text numberOfLines={2} className='flex-1 mr-3 text-[13px]'>
                  {file.DisplayTitle ?? file.Path?.split(/[/\\]/).pop()}
                </Text>
                {deletingIndex === file.Index ? (
                  <ActivityIndicator size='small' color={ACCENT} />
                ) : (
                  <TouchableOpacity
                    onPress={() => confirmDelete(file)}
                    disabled={busy}
                    accessibilityLabel={t("common.delete")}
                  >
                    <Ionicons name='trash-outline' size={20} color='#ef4444' />
                  </TouchableOpacity>
                )}
              </View>
            ))}
          </View>
        )}
      </BottomSheetScrollView>
    </BottomSheetModal>
  );
};

const Badge: React.FC<{ label: string; color: string; background: string }> = ({
  label,
  color,
  background,
}) => (
  <View className='rounded px-1' style={{ backgroundColor: background }}>
    <Text className='text-[9px] font-bold' style={{ color }}>
      {label}
    </Text>
  </View>
);

// The player sheet's colors (PlayerTheme.kt, SubtitleSearchSheet.kt).
const ACCENT = "#9334E9";
const SECONDARY = "rgba(255,255,255,0.5)";
const SHEET_BACKGROUND = "#1C1C1E";

const styles = StyleSheet.create({
  card: {
    borderRadius: 10,
    backgroundColor: "rgba(255,255,255,0.06)",
  },
});
