import { ORIGINAL_LANGUAGE } from "@/utils/jellyfin/serverVersion";
import {
  COMMON_SUBTITLE_LANGUAGES,
  defaultSubtitleSearchLanguage,
  subtitleSearchLanguages,
} from "./api";

const culture = (code: string, name?: string) => ({
  ThreeLetterISOLanguageName: code,
  DisplayName: name,
});

describe("defaultSubtitleSearchLanguage", () => {
  test("starts on the user's subtitle language, in the code the list uses", () => {
    expect(
      defaultSubtitleSearchLanguage({
        defaultSubtitleLanguage: culture("nld"),
      }),
    ).toBe("dut");
  });

  test("starts on English without one", () => {
    expect(defaultSubtitleSearchLanguage({})).toBe("eng");
  });
});

describe("subtitleSearchLanguages", () => {
  const codes = (settings: Parameters<typeof subtitleSearchLanguages>[0]) =>
    subtitleSearchLanguages(settings).map((l) => l.code);

  // Dutch sits far down the list, out of sight in a picker that shows the top.
  test("puts the user's subtitle and audio languages first", () => {
    const languages = codes({
      defaultSubtitleLanguage: culture("nld"),
      defaultAudioLanguage: culture("eng"),
    });

    expect(languages.slice(0, 3)).toEqual(["dut", "eng", "spa"]);
    expect(languages).toHaveLength(COMMON_SUBTITLE_LANGUAGES.length);
  });

  test("lists a language once when both preferences are it", () => {
    const languages = codes({
      defaultSubtitleLanguage: culture("deu"),
      defaultAudioLanguage: culture("deu"),
    });

    expect(languages.filter((code) => code === "ger")).toHaveLength(1);
  });

  test("skips the audio preference for the original language", () => {
    expect(codes({ defaultAudioLanguage: culture(ORIGINAL_LANGUAGE) })).toEqual(
      COMMON_SUBTITLE_LANGUAGES.map((l) => l.code),
    );
  });

  test("adds a preferred language the list lacks, by its own name", () => {
    expect(
      subtitleSearchLanguages({
        defaultSubtitleLanguage: culture("afr", "Afrikaans"),
      })[0],
    ).toEqual({ code: "afr", name: "Afrikaans" });
  });
});
