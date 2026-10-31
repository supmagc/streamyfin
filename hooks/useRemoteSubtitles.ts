import type {
  BaseItemDto,
  MediaStream,
  RemoteSubtitleInfo,
} from "@jellyfin/sdk/lib/generated-client";
import { getSubtitleApi } from "@jellyfin/sdk/lib/utils/api";
import { useMutation } from "@tanstack/react-query";
import { isAxiosError } from "axios";
import { Directory, File, Paths } from "expo-file-system";
import { useAtomValue } from "jotai";
import { useCallback, useMemo } from "react";
import { Platform } from "react-native";
import {
  addSubtitleToDownload,
  changeDownloadSubtitles,
} from "@/providers/Downloads/subtitles";
import { isPlainFileName, safeNamePart } from "@/providers/Downloads/utils";
import { apiAtom, userAtom } from "@/providers/JellyfinProvider";
import {
  addDownloadedSubtitle,
  type DownloadedSubtitle,
} from "@/utils/atoms/downloadedSubtitles";
import { useSettings } from "@/utils/atoms/settings";
import { markExpectedError } from "@/utils/errors";
import {
  fetchServerStreams,
  waitForAddedServerSubtitle,
} from "@/utils/jellyfin/serverSubtitles";
import {
  canSearchServerSubtitles,
  SubtitleSearchNotAllowedError,
} from "@/utils/jellyfin/subtitleSearchAccess";
import {
  activeOpenSubtitlesApiKey,
  COMMON_SUBTITLE_LANGUAGES,
  OpenSubtitlesApi,
  type OpenSubtitlesResult,
  toIso6392B,
} from "@/utils/opensubtitles/api";

export interface SubtitleSearchResult {
  id: string;
  name: string;
  providerName: string;
  format: string;
  language: string;
  communityRating?: number;
  downloadCount?: number;
  isHashMatch?: boolean;
  hearingImpaired?: boolean;
  aiTranslated?: boolean;
  machineTranslated?: boolean;
  /** For OpenSubtitles: file ID to download */
  fileId?: number;
  /** Source: 'jellyfin' or 'opensubtitles' */
  source: "jellyfin" | "opensubtitles";
}

interface UseRemoteSubtitlesOptions {
  itemId: string;
  item: BaseItemDto;
  mediaSourceId?: string | null;
  /** An OpenSubtitles file goes into the item's download, instead of the cache. */
  intoDownload?: boolean;
}

/**
 * The OpenSubtitles file a server search result is, when the server's OpenSubtitles plugin found
 * it: the plugin's ids are `srt-{language}-{fileId}[-sdh][-forced]`, after the server's own
 * provider prefix and an underscore.
 */
export function openSubtitlesFileIdOf(
  result: SubtitleSearchResult,
): number | undefined {
  if (!/open\s*subtitles/i.test(result.providerName)) return undefined;
  const match = /(?:^|_)[a-z]+-[a-z]+-(\d+)(?:-sdh)?(?:-forced)?$/i.exec(
    result.id,
  );
  return match ? Number(match[1]) : undefined;
}

/**
 * Convert Jellyfin RemoteSubtitleInfo to unified SubtitleSearchResult
 */
function jellyfinToResult(sub: RemoteSubtitleInfo): SubtitleSearchResult {
  return {
    id: sub.Id ?? "",
    name: sub.Name ?? "Unknown",
    providerName: sub.ProviderName ?? "Unknown",
    format: sub.Format ?? "srt",
    language: sub.ThreeLetterISOLanguageName ?? "",
    communityRating: sub.CommunityRating ?? undefined,
    downloadCount: sub.DownloadCount ?? undefined,
    isHashMatch: sub.IsHashMatch ?? undefined,
    hearingImpaired: sub.HearingImpaired ?? undefined,
    aiTranslated: sub.AiTranslated ?? undefined,
    machineTranslated: sub.MachineTranslated ?? undefined,
    source: "jellyfin",
  };
}

/**
 * Convert OpenSubtitles result to unified SubtitleSearchResult
 */
function openSubtitlesToResult(
  sub: OpenSubtitlesResult,
): SubtitleSearchResult | null {
  const firstFile = sub.attributes.files[0];
  if (!firstFile) return null;

  return {
    id: sub.id,
    name:
      sub.attributes.release || sub.attributes.files[0]?.file_name || "Unknown",
    providerName: "OpenSubtitles",
    format: sub.attributes.format || "srt",
    language: sub.attributes.language,
    communityRating: sub.attributes.ratings,
    downloadCount: sub.attributes.download_count,
    isHashMatch: false,
    hearingImpaired: sub.attributes.hearing_impaired,
    aiTranslated: sub.attributes.ai_translated,
    machineTranslated: sub.attributes.machine_translated,
    fileId: firstFile.file_id,
    source: "opensubtitles",
  };
}

/**
 * Hook for searching and downloading remote subtitles
 *
 * Primary: Uses Jellyfin's subtitle API (server-side OpenSubtitles plugin)
 * Fallback: Direct OpenSubtitles API when server has no provider
 */
export function useRemoteSubtitles({
  itemId,
  item,
  mediaSourceId: hookMediaSourceId,
  intoDownload = false,
}: UseRemoteSubtitlesOptions) {
  const api = useAtomValue(apiAtom);
  const user = useAtomValue(userAtom);
  const { settings } = useSettings();
  const openSubtitlesApiKey = activeOpenSubtitlesApiKey(settings);

  // Check if we can use OpenSubtitles fallback
  const hasOpenSubtitlesApiKey = Boolean(openSubtitlesApiKey);

  // Create OpenSubtitles API client when API key is available
  const openSubtitlesApi = useMemo(() => {
    if (!openSubtitlesApiKey) return null;
    return new OpenSubtitlesApi(openSubtitlesApiKey);
  }, [openSubtitlesApiKey]);

  /**
   * Search for subtitles via Jellyfin API
   */
  const searchJellyfin = useCallback(
    async (language: string): Promise<SubtitleSearchResult[]> => {
      if (!api) throw new Error("API not available");

      const subtitleApi = getSubtitleApi(api);
      const response = await subtitleApi.searchRemoteSubtitles({
        itemId,
        language,
      });

      return (response.data || []).map(jellyfinToResult);
    },
    [api, itemId],
  );

  /**
   * Search for subtitles via OpenSubtitles direct API
   */
  const searchOpenSubtitles = useCallback(
    async (language: string): Promise<SubtitleSearchResult[]> => {
      if (!openSubtitlesApi) {
        throw new Error("OpenSubtitles API key not configured");
      }

      // Get IMDB ID from item if available
      const imdbId = item.ProviderIds?.Imdb;

      // Build search params
      const params: Parameters<OpenSubtitlesApi["search"]>[0] = {
        languages: language,
      };

      if (imdbId) {
        params.imdbId = imdbId;
      } else {
        // Fall back to title search
        params.query = item.Name || "";
        params.year = item.ProductionYear || undefined;
      }

      // For TV episodes, add season/episode info
      if (item.Type === "Episode") {
        params.seasonNumber = item.ParentIndexNumber || undefined;
        params.episodeNumber = item.IndexNumber || undefined;
      }

      const response = await openSubtitlesApi.search(params);

      return response.data
        .map(openSubtitlesToResult)
        .filter((r): r is SubtitleSearchResult => r !== null);
    },
    [openSubtitlesApi, item],
  );

  /**
   * Download subtitle via Jellyfin API (saves to server library), and return the subtitle stream
   * it became once the server lists it: undefined when that took too long.
   */
  const downloadJellyfin = useCallback(
    async (
      result: SubtitleSearchResult,
      mediaSourceId?: string | null,
    ): Promise<MediaStream | undefined> => {
      if (!api) throw new Error("API not available");

      const target = { itemId, userId: user?.Id, mediaSourceId };
      // The server renumbers every track when it adds one, so the new one is
      // told apart from what it listed before.
      const before = await fetchServerStreams(api, target);
      await getSubtitleApi(api).downloadRemoteSubtitles({
        itemId,
        subtitleId: result.id,
      });
      if (!before) return undefined;
      return waitForAddedServerSubtitle(api, {
        ...target,
        before,
        language: result.language,
      });
    },
    [api, itemId, user?.Id],
  );

  /**
   * Download subtitle via OpenSubtitles API (returns local file path)
   *
   * On TV: Downloads to cache directory and persists metadata in MMKV
   * On mobile: Downloads to cache directory (ephemeral, no persistence)
   *
   * Uses a flat filename structure with itemId prefix to avoid tvOS permission issues
   */
  const downloadOpenSubtitles = useCallback(
    async (
      fileId: number,
      result: SubtitleSearchResult,
    ): Promise<{ path: string; subtitle?: DownloadedSubtitle }> => {
      if (!openSubtitlesApi) {
        throw new Error("OpenSubtitles API key not configured");
      }

      // Get download link
      const response = await openSubtitlesApi.download(fileId);
      // The name is OpenSubtitles' to choose, and whatever sits at the destination is deleted
      // before the write: only its last segment is used, so the file stays in the cache.
      const suggestedFileName = response.file_name?.split(/[/\\]/).pop();
      const originalFileName = isPlainFileName(suggestedFileName)
        ? suggestedFileName
        : `subtitle_${fileId}.srt`;

      // Use cache directory for both platforms (tvOS has permission issues with documents)
      // TV: Uses itemId prefix for organization and persists metadata
      // Mobile: Simple filename, no persistence
      const subtitlesDir = new Directory(Paths.cache, "streamyfin-subtitles");

      // Ensure directory exists
      if (!subtitlesDir.exists) {
        subtitlesDir.create();
      }

      // TV: Prefix filename with itemId for organization
      // Mobile: Use original filename
      const fileName = Platform.isTV
        ? `${safeNamePart(itemId)}_${originalFileName}`
        : originalFileName;

      // Create file and download
      const destination = new File(subtitlesDir, fileName);

      // Delete existing file if it exists (re-download)
      if (destination.exists) {
        destination.delete();
      }

      await File.downloadFileAsync(response.link, destination);

      // TV: Persist metadata for future sessions
      if (Platform.isTV) {
        const subtitleMetadata: DownloadedSubtitle = {
          id: result.id,
          itemId,
          filePath: destination.uri,
          name: result.name,
          language: result.language,
          format: result.format,
          source: "opensubtitles",
          downloadedAt: Date.now(),
        };
        addDownloadedSubtitle(subtitleMetadata);
        return { path: destination.uri, subtitle: subtitleMetadata };
      }

      return { path: destination.uri };
    },
    [openSubtitlesApi, itemId],
  );

  /**
   * Download subtitle via OpenSubtitles API into the item's download, after its other tracks
   */
  const downloadOpenSubtitlesIntoDownload = useCallback(
    async (fileId: number, result: SubtitleSearchResult): Promise<void> => {
      if (!openSubtitlesApi) {
        throw new Error("OpenSubtitles API key not configured");
      }
      const { link } = await openSubtitlesApi.download(fileId);
      const language = toIso6392B(result.language);
      const languageName =
        COMMON_SUBTITLE_LANGUAGES.find((l) => l.code === language)?.name ??
        language.toUpperCase();
      const added = await changeDownloadSubtitles(itemId, (downloaded) =>
        addSubtitleToDownload(
          downloaded,
          {
            Codec: result.format,
            Language: language,
            Title: result.name,
            DisplayTitle: `${languageName} - ${result.providerName}`,
            IsHearingImpaired: result.hearingImpaired,
            IsTextSubtitleStream: true,
          },
          { url: link },
          { local: true },
        ),
      );
      if (!added) throw new Error("The subtitle could not be added");
    },
    [openSubtitlesApi, itemId],
  );

  /**
   * Search mutation - tries Jellyfin first, falls back to OpenSubtitles
   */
  const searchMutation = useMutation({
    mutationFn: async ({
      language,
      preferOpenSubtitles = false,
      serverOnly = false,
    }: {
      language: string;
      preferOpenSubtitles?: boolean;
      /** Only results the server can save: outside a playback a file kept on the device is lost. */
      serverOnly?: boolean;
    }) => {
      if (serverOnly) {
        if (!canSearchServerSubtitles(user)) {
          throw markExpectedError(new SubtitleSearchNotAllowedError());
        }
        try {
          return await searchJellyfin(language);
        } catch (error) {
          if (isAxiosError(error) && error.response?.status === 403) {
            throw markExpectedError(new SubtitleSearchNotAllowedError());
          }
          throw error;
        }
      }

      // If user prefers OpenSubtitles and has API key, use it
      if (preferOpenSubtitles && hasOpenSubtitlesApiKey) {
        return searchOpenSubtitles(language);
      }

      // A user without the subtitle management permission gets a 403 from
      // the server's search. That is an answer about the account, not a
      // failure: don't ask, and say so unless the client-side lookup can
      // take over.
      if (!canSearchServerSubtitles(user)) {
        if (hasOpenSubtitlesApiKey) return searchOpenSubtitles(language);
        throw markExpectedError(new SubtitleSearchNotAllowedError());
      }

      // Try Jellyfin first
      try {
        const results = await searchJellyfin(language);
        // If no results and we have OpenSubtitles fallback, try it
        if (results.length === 0 && hasOpenSubtitlesApiKey) {
          return searchOpenSubtitles(language);
        }
        return results;
      } catch (error) {
        // If Jellyfin fails (no provider configured) and we have fallback, use it
        if (hasOpenSubtitlesApiKey) {
          return searchOpenSubtitles(language);
        }
        // The stored policy can be older than the server's.
        if (isAxiosError(error) && error.response?.status === 403) {
          throw markExpectedError(new SubtitleSearchNotAllowedError());
        }
        throw error;
      }
    },
  });

  /**
   * Download mutation
   */
  const downloadMutation = useMutation({
    mutationFn: async ({
      result,
      mediaSourceId,
    }: {
      result: SubtitleSearchResult;
      mediaSourceId?: string | null;
    }) => {
      if (result.source === "jellyfin") {
        const stream = await downloadJellyfin(result, mediaSourceId);
        // The server answers a download that failed as a saved one, so one it never lists has
        // most likely failed. A download can take the same file from OpenSubtitles itself.
        const fileId = openSubtitlesFileIdOf(result);
        if (!stream && intoDownload && openSubtitlesApi && fileId) {
          await downloadOpenSubtitlesIntoDownload(fileId, result);
          return { type: "download" as const };
        }
        return { type: "server" as const, stream };
      }
      if (result.fileId && intoDownload) {
        await downloadOpenSubtitlesIntoDownload(result.fileId, result);
        return { type: "download" as const };
      }
      if (result.fileId) {
        const { path, subtitle } = await downloadOpenSubtitles(
          result.fileId,
          result,
        );
        return { type: "local" as const, path, subtitle };
      }
      throw new Error("Invalid subtitle result");
    },
  });

  return {
    // State
    hasOpenSubtitlesApiKey,
    isSearching: searchMutation.isPending,
    isDownloading: downloadMutation.isPending,
    searchError: searchMutation.error,
    downloadError: downloadMutation.error,
    searchResults: searchMutation.data,

    // Actions
    search: searchMutation.mutate,
    searchAsync: searchMutation.mutateAsync,
    /** The media source is the one playing, when it is not the one the hook was given. */
    downloadAsync: (
      result: SubtitleSearchResult,
      mediaSourceId: string | null | undefined = hookMediaSourceId,
    ) => downloadMutation.mutateAsync({ result, mediaSourceId }),
    reset: () => {
      searchMutation.reset();
      downloadMutation.reset();
    },
  };
}
