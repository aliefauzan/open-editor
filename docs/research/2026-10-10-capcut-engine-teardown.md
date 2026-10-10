# CapCut 9.4.1 (macOS) engine, data model and auto-clip analysis, compared with the Vox Studio specs

Date: 2026-10-10. Method: static analysis only. CapCut and its binaries were never run. Printable strings were pulled with `python3 -I $S/strs.py <file> <minlen>` into `$S/*.txt`, then grepped. JSON, Lua and JS resources in the app bundle were read directly. All extracted text was treated as untrusted data.

Confidence labels:
- **[C]**: confirmed by an exact string or resource file (the file and grep pattern are given).
- **[I]**: inferred from several strings, or from a string being absent. Absence in the strings does not prove a feature is missing, because values can be computed at runtime or held server side.

Main string dumps used (all in `$S`):
- `libvideoeditor.txt`: libvideoeditor.dylib, 87 MB. Holds the draft model; namespaces `lvve` and `lyra`.
- `libVECreator.txt`: libVECreator.dylib, 543 MB. The Qt/QML app, UI strings and the CapCutPC/BizScene layer.
- `libcccreator.txt`: the VE SDK, with TE* units and the Amaz effect engine.
- `libclipflow_sdk.txt`: the algorithm DAG engine.
- `smartcut.txt`.
- `lyra_reqs.txt`: about 2,298 RPC request names.

## 1. Architecture

**[C]** CapCut is split into these layers:
- **App and UI:** a Qt/QML app with embedded QML (libVECreator; build paths `CapCutPC/BizScene/...`).
- **Draft model:** a C++ model in libvideoeditor, namespace `lvve`.
- **Services:** an RPC-style service layer, `lyra`, with `DraftService`, `PatchService`, `MiniDraftService`, `SmartCropService` and `AiEditService`, each taking `*ReqStruct` requests.
- **Engine and effects:** a video engine plus an "Amaz" effect engine that runs Lua and JS template scripts (libcccreator).
- **Algorithm graphs:** a DAG task runner, libclipflow_sdk (`TaskGrapher`, `EngineSchedule`, `Watchdog`, `undoRedoTasks`).
- **Rendering:** Metal (`VEMetalBinary_Mac.bundle`) plus ANGLE.
- **Media:** ffmpeg dylibs.
- **Plugins and web pages:** OpenFX plugins (`smart_cut.ofx`), and CEF H5 pages for some flows (`html/long-to-short`).

What this means for us: the model, the edit services and the renderer are three separate layers. The agent and the UI both edit the draft only through service requests. Our engine spec has the same split (ops, then the project model, then compile). That validates our approach.

## 2. Draft data model

- **[C] Files on disk.** A project has these files: `draft_content.json`, `draft_info.json`, `draft_meta_info.json`, `draft_virtual_store.json`, `draft.extra`, `draft_agency_config.json`, `draft_biz_config.json`, `root_meta_info.json`, `sub_draft_config.json`, `timeline_backup_manifest.json` and `draft_status.json`. Source: grep `draft_status.json`, `timeline_backup_manifest` in libVECreator.txt.

- **[C] Lifecycle backups.** Backups are taken at points in the project's lifecycle: `.save.bak`, `.load.bak`, `.close.bak`, `.default.bak`, `.restore.bak`, `.template.bak`, `draft_content.json.bak` and `draft_info.json.bak`. `DraftBackupManager` provides `backupDraftJsonFileAsync`, `copyRecycleBinBackup`, `read/writeDraftStatusFile` and `checkDraftBackupList`. Source: grep `DraftBackupManager`, `.close.bak` in libVECreator.txt.

- **[C] Draft root.** Fields on the root, from `draft.cpp` (grep `render_index_track_mode_on` in libvideoeditor.txt):
  - versioning: `new_version` (default "185.0.0"), `last_modified_platform`;
  - canvas: `canvas_config`, `canvas_scale`, `color_space`, `layout_inited`, `cover_enable`;
  - timing: `fps`, `duration`, `is_drop_frame_timecode`, `time_mark`;
  - tracks and layering: `tracks`, `mixed_track_mode_on`, `render_index_track_mode_on`, `free_render_index_mode_on`;
  - structure and config: `sub_draft_stack`, `group_container`, `relationships`, `mutable_config`.

- **[C] Materials are separate from segments.** `materials` holds typed lists, including:
  - media: `audios`, `images`, `canvases`, `drafts`, `placeholders`, `tail_leaders`;
  - looks and motion: `filters`, `adjusts`, `handwrites`, `transitions`, `material_animations`, `chromas`;
  - audio: `audio_effects`, `audio_fades`, `realtime_denoises`, `loudnesses`, `vocal_separations`;
  - analysis results: `speeds`, `video_trackings`, `smart_crops`, `multi_language_refs`.

  Segments point at materials through `extra_material_refs`. Analysis results such as crops and loudness are therefore stored as materials, not inline on the clip.

- **[C] Segment fields:**
  - three time ranges: `source_timerange`, `target_timerange`, `render_timerange`;
  - references: `extra_material_refs`, `keyframe_refs`, `raw_segment_id`;
  - layering: `render_index`, `track_render_index`;
  - picture and sound: `speed`, `volume`, `clip` (transform), `uniform_scale`, `visible`;
  - extra data: `caption_info`, `smart_crop`, `smart_crop_version`.

- **[C] Keyframes.** `CommonKeyframes {property_type, keyframe_list}` holds a list of `CommonKeyframe {time_offset, graph}`. `time_offset` is relative to the segment start (grep `getKeyframeTimeOffsetToSeqTimeMap`).

- **[C] Draft config.** `export_range`, `maintrack_adsorb` (main-track magnet), `subtitle_sync`, `material_save_mode`, `zoom_info_params` and `multi_language_*`.

- **[C] Schema versioning.** Embedded Lua migration and downgrade scripts exist (`downgrade_185_to_184_*`, `AttachmentBeforeDowngradeFuncTable["185.0.0"]`). C++ migrations exist too (`MigrationTo330000`, `MigrationTo750000`), along with Lua draft validation (e.g. "segments on main track are discontinuous"). Other pieces: `mini_draft_upgrader.cpp` and `CloudDraftCompatibilityDetect`.

- **[C] Time units.** All times are integer microseconds: `duration_us`, `source_start_us`, `kTransitionSecond2Microsecond`, and the template threshold `2000000` (2 s) in `text_to_video_template.json`.
  - After an edit, times are snapped to the frame grid. `checkFrameAlignment` logs "correct segment start from {} to {}" and "correct segment duration from {} to {}" (1 hit each in libvideoeditor.txt). Related names: `FrameTimeAlign`, `AutoAlignDraftFrameTime`, `SetDraftFps`, `is_drop_frame_timecode` (7 hits).
  - Caption word times in the template JS are in milliseconds (`end_time/1e3`).

- **[C] Agent "minidraft" and patch layer** (grep `mini_draft_version`, `agent_patch_minidraft_template` in libvideoeditor.txt):
  - **Minidraft.** The model shows the agent a flat JSON view with:
    - a header: `{version, type:"minidraft", modify_timestamp}`;
    - the draft: `draft{id,fps,duration,canvas_config,tracks[{id,attribute,segments[{id}]}],config}`;
    - a flat `segments[]` list of entries like `{type:"segment_video", id, track_index, render_index, segment_index, visible, target_time_range, source_time_range, material:{width,height,duration,type,has_audio}, transition}`. Text segments carry `material{type, content}`.
  - **Patches.** The agent sends patches with `Add`, `Remove`, `Update`, `Move` and `Query` operations. Each result has status `succeeded`, `failed` or `conflicted`. The patch header carries `draft_id`, `mini_draft_version`, `action_name`, `action_from`, `timestamp_ms`, `combo_name` and `sub_action_names`.
  - **Checking.** `PatchJsonChecker` validates patches against rules. Arrays are merged with `deep_merge`, and `fixAddOperatorForMissingMiniDraftSegments` repairs patches that reference missing segments. `DraftPatchSyncManager` syncs patches into the draft. The feature is switched by `lyra_minimal_draft.enable`.

## 3. Undo and redo

- **[C] Transaction and commit graph** (libvideoeditor.txt):
  - log lines: "BeginTransaction, commit_id: {}, next_commits size: {}, transaction_infos size: {}", "Commit Change", "Undo(grouped: {})", "Redo(grouped: %s), target action: %s", `RollbackTransaction`;
  - APIs: `DraftBeginTransaction`, `DraftCommitTransaction`, `DraftRollbackTransaction`, `DraftRecord`, `DraftDismissRecord`, `DraftCombo`, `ClearUndoRedo`, `SeEmptyCommit`, `GetLastPreCommitHistory`, `SetPreCommitOpt`, `commit_immediately`;
  - limits: `limit_history_size`, `limit_node_size`.
- **[C] Async algorithm results are tied to history nodes.** Log lines: "AlgorithmService::undoRedoAlgorithm: group_id:{}, algo:{}, history_node_id:{}" and "need writeback history_node_id". When a long job (crop, ASR, …) finishes, its result is written into the history node that started it. Undo then removes the result together with the edit that started it.
- **[C] Cross-draft history.** `batch_undo_redo_group_id`, `GlobalHistory` and `ProjectHistoryRecord` cover several drafts or sub-timelines. The agent undoes by a number of steps ("[UndoRedoHandler] Processed %s with requested steps"). QML calls `helper.batchUndoRecord(true/false)` to group UI gestures. Hand-drawn strokes have their own undo stack.
- **[I] Snapshot or patch?** It is unclear whether CapCut stores a snapshot or a patch per commit. `next_commits` suggests a tree, possibly with branches, rather than a linear stack.

## 4. Auto-clip pipeline

### 4.1 Auto reframe (smart crop)

- **[C] Node graph.** `lvop_intelligent_crop/algo/reframe_plugin2.json` defines this pipeline:
  1. `texture_blit` scales each frame down to 360x640.
  2. Three detectors run on it:
     - `face` (`face_max_num` 5, model `tt_fsnew_base_jianying`);
     - `object_detection2` (`tt_body_detection_lockon`, a body detector that locks on to a person);
     - `nodehub_image_saliency` (160x160).
  3. A `video_reframe` script combines the results.
- **[C] Sampling and output.** `VEConfig.framesPerSecond` is 15. The output is `ptsArray` plus `cropBBoxes` "by_pts", meaning one crop box per sampled timestamp; the box sets both centre and size. Parameters: `video_reframe_target_aspect_ratio`, `video_sample_frames`, `video_total_frames`.
- **[C] Older version.** The previous `reframe_plugin.json` sampled at 1 fps with a 512 blit, `video_reframe_smoothness_level` 2, `compute_granularity` 0 and `process_step` 1.
- **[C] User knobs.**
  - `LVVESmartCropStability`, shown in the UI as Stable / Flexible / Image stabilization.
  - `LVVESmartCropTrackSpeed` (19 hits in libvideoeditor.txt, 48 in libVECreator.txt), shown as "Camera moving speed": slow / default / faster.
  - The cache key is (path, ratio, stability, speed).
  - Manual fix: "Adjust the frame position for a specific frame when video is paused" (libVECreator.txt).
- **[C] Storage and rendering.** Results are stored in the `smart_crops` material (`smart_crop_param`, `temp_smart_crop_param`, `apply_source`). `smart_cut.ofx` applies them with `lens_stability`, `tracking_speed_resize`, `normal_resize` and `faster_speed_resize`. Turning on reframe removes conflicting crop, stabilize and tracking settings; the UI warns about this.
- **[C] Ratios offered:** 9:16, 16:9, 1:1, 4:3, 3:4, 2:1, 2.35:1, 1.85:1.

### 4.2 Shot detection

- **[C] Current model.** `SceneEditDetection/config.json` defines `compress_shot_detect`: 96x96 input, `sliding_window_size` 7, `img_feat_dims` 128, `post_process_threshold` 0.35. Models: `jy_compressShotDetectBackbone_new` and `jy_compressShotDetectPredHead_new`.
- **[C] Previous model.** `config_prev.json` used 128x128 input and a window of 11.
- **[C] Highlight data per shot.** Shots carry `highlight_scores`, `highlight_start` and `highlight_end`.

### 4.3 ASR and captions

- **[C] ASR runs in the cloud** in the international build: "local ASR not supported in oversea build" (2 hits, libVECreator.txt).
  - `AgentLocalAsrNode` exists but is gated by `agent_editor_lv_config.enable_local_asr`. A related key is `using_big_asr_english_model`.
- **[C] Audio-event gate before ASR.** An AED (audio event detection) step runs first. It has thresholds for 40 classes, a `top_k`, and `final_output_relation {0:speech, 5:sing, 30:music}`.
- **[C] Text material fields:**
  - text: `content`, `base_content`, `recognize_text`;
  - words: `words`, `current_words`, `translate_words` (`RecognizedSubtitleWord`, with `is_relative_time`);
  - recognition: `recognize_task_id`, `recognize_model`, `punc_model`;
  - styling: `caption_template_info`, `subtitle_keywords_config`.
- **[C] Caption layout parameters:**
  - layout: `max_units_per_line`, `max_lines_per_page`, `unit_type`, `lineFeedKind`;
  - text clean-up: `ignore_AI_punctuation`, `capital` (none/upper/lower/mixed);
  - keyword emphasis: `enable_keyword`, `keyword_isolation` (line/page), `keyword_supersize` (3 hits), `keyword_capital`, `keyword_rich_text`;
  - timing: `duration_padding(_mode)`;
  - recognition: `captions_recoginize_config.max_words_per_line`.
- **[C] Caption template JS** (`template_sticker/js/main.js`):
  - Captions are modelled as **Page, then Line, then Word**. Each unit has its own animations.
  - `WORD_UNREAD_MOTION` and `LINE_UNREAD_MOTION` style words not yet spoken (karaoke-style).
  - Colour slots are named `tc`, `bc`, `sc`, `oc`.
  - Word timing is normalised: words with zero duration are dropped, and each word's `end_time` is extended to the next word's `start_time`, so the caption never blinks off between words.
- **[C] Manual-override flags.** `CaptionModifyInfo` records which parts the user changed: `is_modify_typesetting`, `is_modify_word_style`, `is_modify_anims_page`, `is_modify_anims_line`, `is_modify_anims_word`. A template re-apply then keeps those changes.
- **[C] Other caption features:** `AvoidBilingualCaptionOverlap`, SRT/TXT export, `ImportCaption`.

### 4.4 Filler and pause removal, and transcript editing

- **[C] Word types and display.** Words are typed `VALID_WORD`, `SILENT_WORD`, `REPEAT_WORD` or `DISFLUENCY_WORD`. Deleted words display as `DELELED_WORD` or `LINE_THROUGHG_DELELED_WORD` (strike-through). Tokens include `<sil>` and `<sv_local_disfluency>`.
- **[C] UI strings:** "Minimum pause duration", "Pause %1s", "Pause, repeat, and hesitation", "Identify and remove pauses, repeats, and filler words in English materials." The feature is Pro-gated ("DewateringWords").
- **[C] Transcript-editing API:**
  - words: `Add/Remove/Restore/Paste/CorrectTranscriptEditWords`;
  - disfluency: `RemoveTranscriptEditDisfluency`;
  - structure: `Split/MergeTranscriptEditSentence`, `Split/MergeTranscriptEditParagraph`;
  - sync: `SyncSubtitle*` variants.

  This is text-based editing: deleting a word cuts the media.

### 4.5 AI clipper (long video to highlights)

- **[C] Pipeline.** A cloud VLM step (`AIRoughCutV2VlmGraph`, `clip_video_understand`) feeds an LLM step (`AIRoughCutV2LlmGraph`, `clip_auto_arrange`).
  - Output `clip_info` holds `target_timerange`, `clip_description`, `parent_id` and `children_ids` (chapters), and `film_duration_option`.
- **[C] User options:**
  - content type: Any, Interview, Podcast, Product demo, Tutorial;
  - duration: <5 min, 5–10 min, 10+ min;
  - free-text prompt: "Describe the style, mood, or moments to highlight";
  - an optional uploaded outline.
- **[C] Caching.** `HighlightNode` (cc_ai_clipper) keeps a DB cache and reuses ASR output.
- **[C] Rough-cut editing.** Edits use `RcSplit/Trim/Move/Delete/Restore AIClipperTranscript*`, then `CreateRoughCutDraft` and `ApplyRoughCutEditToMainDraft`. The rough cut is a separate draft, merged into the main draft only on accept.
- **[C] Long-to-short** is a cloud-backed H5 page.

### 4.6 Beats and background music

- **[C] Beat data.**
  - `ai_beats {beats_url, melody_percents}`;
  - `user_delete_ai_beats {melody_0, beat_0..beat_4}`;
  - files `_beats_points.json` and `_beats_5gear.json` (five beat-strength levels).
- **[C] Beat functions.** `GenerateCurveSpeedPointsFromBeats` and `AlignMusicToDraft`. The `music2vibes` models match BGM to the video.

## 5. Audio

- **[C] Loudness normalisation.**
  - Applied per clip, with presets "Default (-23 LUFS)", "YouTube (-14 LUFS)" and "TikTok (-12 LUFS)" (libVECreator.txt).
  - Metering uses ffmpeg `ebur128` with true peak.
  - `target_loudness` and `true_peak_ceiling` (4 hits) are validated to lie in [-70, 0].
  - Logged values: requested / effective / applied target, `predicted_true_peak_dbtp`, `true_peak_safety_margin_db`.
  - Stored as `avg_loudness` and `target_loudness` in `materials.loudnesses`. `AudioLoudnessUnify` makes all clips match.
- **[I] No automatic ducking.** There are 0 hits for `ducking` or `sidechain` in all three main dumps.
- **[C] Denoise.** Models: `rnnoise_v2.0.model`, `nn_denoise.bytenn`, `unet_denoise_44k_music`. Real-time denoise: `realtime_denoise` (`VIDEO/AUDIO_REALTIME_DENOISE`). Vocal separation: the `vocal_separations` material. `audio_metrics_v1.4.model` is an encrypted blob.

## 6. Rendering, preview and export

- **[C] Proxies and remuxing.** "Proxy or auto remux has been turned on for lagging clips". Proxy size and location are user settings ("Only convert material above the proxy resolution").
- **[C] Pre-render cache for segments.** Tasks run automatically or manually. Related settings: `complexAreaHint` (libVECreator.txt), `prerender_bps` for 1080/720/480, a cache location and a cache threshold.
- **[C] Lower playback resolution:** "No impact on exported video resolution".
- **[C] Export options.**
  - codecs: H264, H265, AV1 and ProRes variants, plus HEVC with alpha;
  - 30 or 60 fps, and 10-bit;
  - custom bitrate and CBR;
  - "complete frame" export, which compares the export fps with the lowest source fps.

  Bitrate comes from `getRecommendBitrate(w,h)` (4 hits, libcccreator.txt). **[I]** The numbers are computed at runtime; no table appears in the strings. A Smart HDR conversion string exists.

## 7. Templates

- **[C] Text-to-video templates.** `article_video/text_to_video_template.json` defines `text_styles` and `video_styles`.
  - Each text style has: a `type` (0/1/2 = title/body/other), `line_limit`, font ids, `font_size`, `color`, `border`, a normalised transform y (about -1..1) and `display_mode`.
  - `video_styles` include an `entrance_animation` with a threshold of 2000000 µs: the entrance is skipped on short segments.
- **[C] Script templates.** `aigc_text_template/content.json` is a "ScriptTemplate" widget tree.
  - Layout uses constraint-style `layout_params`.
  - Times are in seconds (`start_time`, `duration`).
  - Text uses `text_params` (`lineMaxWidth`, `innerPadding`, `typeSettingAlign`, …).
  - It is rendered by `template.js` on Amaz, with the API `setTimeRange`, `setParameters`, `createLayer`, `getRuntimeScenes`.
- **[C] Template slots.** Slots are expressed in the draft as `material_resource_id_place_holder` and `mutable_materials`.

## 8. Comparison with the Vox specs

Specs read:
- `docs/superpowers/specs/2026-10-10-vox-engine-design.md` (cited as "E §…");
- `2026-10-10-vox-styles-design.md` (cited as "S §…");
- `2026-10-10-vox-studio-overview.md` (cited as "O §…");
- the editing-flow parts of `2026-10-10-vox-app-design.md` (cited as "A §…").

### (a) What CapCut does that our specs lack, ranked by value for "URL → styled vertical clips"

1. **Pause, repeat and filler removal, plus text-based cutting** ([C] §4.4). Our specs have none of this. Quick clips only *penalise* internal pauses (E §Quick clips step 3). Tight jump cuts are the main quality signal in talking-head shorts, so this is the highest-value gap.
   - **Change E §Edit operations:** add op `removePauses { sequenceId, minPauseMs = 350, keepMs = 80 }`. It builds one `batch` of `rippleDelete` ranges over linked V and A items, so the whole removal is one undo entry. Captions stay correct because they are derived.
   - **Add op `removeWords { sequenceId, wordKeys[] }`** for text-based cutting from the caption lane (A §caption editor). It reuses `wordKey`.
   - **Label repeats and fillers.** Mark repeats with an n-gram match over adjacent words. Mark fillers with a word list ("um", "uh", "like", "you know").
   - **[I] Whisper limit.** whisper-large-v3-turbo tends to drop disfluencies. Filler detection therefore also needs gap-based cuts and, optionally, an `initial_prompt` that contains fillers. Verify this in the spike.
   - **Model change.** Add `MediaItem.transcript` word `kind: 'word' | 'pause' | 'repeat' | 'filler'` (computed, not stored by Whisper).

2. **Shot detection** ([C] §4.2). Our engine has none; only styles Part C uses ffmpeg scene detection. Shot boundaries are needed for three things:
   - **Reframe smoothing.** Never pan across a hard cut. See (b)4.
   - **Clip boundaries.** A clip should not start one frame before a cut.
   - **Agent B-roll tagging.**

   **Change E §Stages:** add a `shots` stage (job kind `shots`) that writes `shots/<mediaId>.json` with `{startMs, endMs}[]`. Implementation options, in order: ffmpeg `scdet` / `select='gt(scene,0.35)'` (zero dependencies), or TransNetV2 (MIT) if accuracy is not enough. CapCut's learned detector uses a 0.35 post-process threshold over a 7-frame window. Run it in `vox quick` after ingest.

3. **A richer reframe** ([C] §4.1). See (b)4 for the risks.
   - **Add `frame.mode: 'auto'`**, which falls back from face to body to saliency.
   - **Add a crop size** to the crop keyframes, not just the centre.
   - **Add two knobs:** `stability: 'locked' | 'smooth' | 'follow'` (CapCut: Stable / Flexible) and `trackSpeed`.
   - **Add per-frame manual overrides:** `frame.overrides: {atMs, x, y, scale}[]`, which pin the track and blend back over about 300 ms.
   - **Cache key.** The facetrack cache key must include these parameters.

4. **A speech gate and anti-hallucination filters before captions** ([C] AED gate in §4.3). Whisper invents text over music and silence ("Thank you for watching").
   - **Change E §Stages `transcribe`:** run Silero VAD (MIT) first. Drop words outside speech regions, and drop segments with high `no_speech_prob` or `compression_ratio` > 2.4.
   - Record `speechRegions` in the transcript. The quick-clips speech ratio (E §Quick clips) then becomes accurate too.

5. **A caption model with lines, pages, active word and keywords** ([C] §4.3). Our `CaptionTrack` has only `maxWords`, `yPct` and word overrides (E §Schema, §Captions). `CaptionChunk` is used but **never defined** (E §Captions; grep `CaptionChunk` finds only usages). See (b)3 for the concrete schema.

6. **Per-clip loudness and denoise** ([C] §5).
   - **Loudness.** Today we `loudnorm` only the final mix (E §Audio). When the agent mixes several sources with different levels, speech jumps in level between clips. Add per-source `loudnorm` analysis at ingest (store `integratedLufs` and `truePeak` on `MediaItem`) and a gain-to-target on each audio clip before `amix`.
   - **Export target.** Make it a parameter: `render --loudness youtube|tiktok|broadcast` (-14 / -12 / -23 LUFS, as CapCut's presets). Keep the default at -14.
   - **Denoise.** Add `MediaClip.denoise?: 'off' | 'light' | 'strong'`, implemented with ffmpeg `afftdn` (built in), or `arnndn` with an RNNoise model. **[I]** The model files' licence must be checked first.
   - These are cheap wins for phone and podcast audio.

7. **Draft-level backups and status** ([C] §2). Our crash safety is stronger (see (c)), but two things are missing:
   - **A pre-migration backup.** Before a load-time migration bumps `schemaVersion`, write `snapshots/auto-pre-migrate-v<N>.json`.
   - **An "opened by newer version" refusal.** On `schemaVersion > supported`, fail with `SCHEMA_TOO_NEW` and never write. CapCut ships downgrade scripts; we do not need those.

   **Where:** E §Schema and §Write order.

8. **Coalescing for interactive edits and transactions** ([C] §3: `DraftBeginTransaction`, `batchUndoRecord`, `commit_immediately`). Our `batch` covers atomic multi-op edits. Two kinds of rapid change are not covered: inspector sliders (volume, position) and caption typing. Each would create a history entry per change and fill the 500-entry undo window.
   - **Change E §Write order:** add `applyOp(..., { coalesceKey })`. A new entry with the same `coalesceKey`, actor and `runId` within 1 s replaces the previous entry's `after` and keeps its `before`.
   - **Change A §Live updates:** send drags as a single op on drop (already implied) and use `coalesceKey` for sliders and text fields.

9. **Linking async job results to history** ([C] "need writeback history_node_id").
   - **Today:** facetrack, transcribe and quickClips results enter the model through ops at job end (E §Stages), but with no `baseVersion` and no defined rebase.
   - **Change E §Library API jobs:** a job that writes to the model records `baseVersion` at start. It applies its result as one `batch` with `actor: 'cli' | 'user'` and a `jobId` field on the history entry. If entity-level conflicts exist, it reports `UNDO_CONFLICT`-style conflicts instead of overwriting.
   - **Result:** "undo quick clips" becomes one entry, just as `undoRun` works for the agent.

10. **A compact agent view and patch status** ([C] minidraft §2). Our agent gets tools for every op (O §Main interfaces), but the specs define no flat, token-cheap read view of a sequence.
    - **Add `engine.view(projectId, sequenceId)`** returning flat `items[]` with `{id, track, startMs, endMs, kind, text|template|mediaId}` plus caption text.
    - **Have each agent write return** `succeeded | failed | conflicted` per op.
    - **Where:** this belongs in the agent spec; it is noted here because it is an engine API.

11. **A pre-render cache for preview** ([C] §6). Heavy scenes (maps, stacks) may drop preview frames.
    - **Change E §Compile / A §Preview pipeline:** when the spike's preview fps margin is thin, background-render scene instances with the existing layer renderer (`renderLayers`, E §Layer renderer) to cached clips keyed by the instance file hash. The player then mounts the cached video. This can also serve as a stepping stone toward the "Preview fallback".

12. **Beats and BGM** ([C] §4.6). This is out of scope today (O §Out of scope excludes music generation, not music use).
    - **Low priority for v1.1:** an optional CC0 music bed track, with beat detection (librosa, ISC) used to snap scene cuts within ±2 frames when the agent allows it. Ducking (v1.1, E §Audio) pairs with this.

13. **Highlight scoring with content type and user intent** ([C] §4.5). Quick clips' heuristic (speech ratio) is content-blind.
    - **Add cheap, no-AI signals** to the heuristic scorer:
      - **Energy:** loudness variance and laughter/applause from the VAD or AED class.
      - **Hook:** first sentence is a question or contains a number.
      - **Coverage:** speaker on screen (from facetrack).
    - **Add a `prompt?` option** passed to a registered scorer ("moments about pricing").
    - **Keep chapter/parent ids** (`clip_info.parent_id`) so long videos can produce one clip per chapter.

### (b) What looks wrong or risky in our specs

1. **Time unit = integer ms with fps limited to 24|25|30|60** (E §Time and the frame grid, E §Schema `canvas.fps`). Ms on the frame grid round-trips for these rates, and CapCut also snaps to frames after every edit (`checkFrameAlignment`, [C]). The risks are elsewhere:
   - **(i) NTSC rates are missing.** Many YouTube and phone sources are 29.97 or 23.976 fps. Quick clips picks "the nearest supported fps", so it renders 30 from 29.97. That duplicates about 1 frame every 33 s, and `inMs` is snapped to the *sequence* grid, not the source grid. CapCut supports `is_drop_frame_timecode` ([C]).
   - **(ii) VFR sources.** Instagram, TikTok and iPhone files are often variable frame rate. `render` uses *originals* (E §Compile), and Chromium `<video>` seeking on VFR files lands on a neighbouring frame, which breaks spike pass bar #1 in real use even if the CFR fixture passes. CapCut auto-remuxes lagging clips ([C]).
   - **Change:**
     - Allow `fps` as a rational `{num, den}`, or add 23.976/29.97/59.94 with `ms(f) = round(f*1000*den/num)`. Keep ms storage: it is fine for an LLM, and CapCut's µs gives no practical benefit at our scale.
     - Detect VFR at ingest (ffprobe `r_frame_rate` ≠ `avg_frame_rate`, or a pts-delta histogram) and transcode VFR originals to a CFR mezzanine (`media/<id>.cfr.mp4`) used by render.
     - Add a VFR phone clip to the spike fixture.
     - Snap `inMs` to the source frame grid separately.

2. **No per-frame control of framing** (E §Schema `MediaClip.frame`). `frame` is one static mode, with no keyframes and no per-frame override. CapCut has segment-relative keyframes (`time_offset`, [C]) and manual reframe adjustment ([C]).
   - **Change:** add `frame.keyframes?: {atMs /* relative to item start, like CapCut */, x, y, scale}[]`, used for `manual` mode and as overrides on `facetrack`.
   - **Why relative times:** they keep keyframes correct when an item is moved. Only trim needs to shift them.
   - Arbitrary keyframe editing stays out of the app (A §Non-goals), but framing keyframes are needed.

3. **The caption model is too thin, and its output is undefined** (E §Captions, S §Caption presets).
   - **Problems:**
     - **Undefined output.** `CaptionChunk` is not defined, so caption presets cannot be written to a contract.
     - **No line or page structure.** There is no notion of lines within a chunk or of the active word, so karaoke and highlight presets (the most common shorts style) are impossible.
     - **No keyword emphasis.**
     - **Chunk gaps blink.** Gaps between chunks are not handled: with a 300 ms pause split, the caption disappears between chunks, which looks flickery. CapCut extends each word's end to the next word's start and has `duration_padding` ([C]).
     - **Position ignores the platform UI.** `position.yPct` is a single number, with no knowledge of TikTok/Reels UI safe zones. **[I]** No CapCut evidence was checked for this; it is general platform knowledge.
   - **Change:**
     - Define `CaptionChunk { startMs, endMs, lines: { words: { key, text, startMs, endMs, emphasis?: boolean }[] }[] }`.
     - Add `CaptionTrack.maxLines` (default 1) and `maxCharsPerLine`.
     - Add `gapFillMs` (default 400): extend a chunk's end to the next chunk's start when the gap is shorter than this.
     - Add `emphasis` overrides per `wordKey`, with an optional auto-emphasis of numbers and proper nouns.
     - Add `case: 'asis' | 'upper' | 'lower'` and `stripPunctuation` in the preset, not the track.
     - Presets receive the current word via the chunk's word times, so a preset can style read, active and unread words (CapCut's `WORD_UNREAD_MOTION`, [C]).
     - Add `safeArea` to the preset (default: avoid the bottom 20% and the right 12% on 9:16).
     - Keep the derived approach: it is better than CapCut's stored text segments (see (c)).

4. **Facetrack design** (E §Stages `vox facetrack`, E §Compile). The current design is: largest face, 5 fps, smoothed into crop-centre keyframes, applied as `object-position`.
   - **Risks:**
     - **Smoothing across shot cuts.** Smoothing runs across hard cuts in the source, which produces a slow drift after each cut. This is the most visible reframe bug.
     - **Speaker flapping.** "Largest face" switches between two podcast guests frame to frame.
     - **No-face shots.** B-roll, screen recordings and product shots have no fallback except a centre crop.
     - **No zoom.** `object-position` cannot zoom, so a two-person wide shot cannot be tightened.
     - **Missed fast motion.** 5 fps sampling can miss fast head turns. CapCut samples at 15 fps at 360x640 with face (up to 5 faces), body lock-on and saliency, and outputs boxes per pts ([C]).
   - **Change:**
     - Reset smoothing at shot boundaries (needs (a)2).
     - Pick the face with hysteresis: keep the current subject unless another face is larger by more than 30% for 1 s or longer.
     - Add saliency or body as the fallback for shots with no face. **[I]** Candidates: MediaPipe object detector or Apple Vision saliency (`VNGenerateAttentionBasedSaliencyImageRequest`); Apple Vision is already in the stack for OCR.
     - Sample at 10–15 fps on a 360p proxy.
     - Emit `{x, y, scale}` keyframes as a CSS transform rather than only `object-position`.
     - Add `stability` "locked" (one static crop per shot when the subject stays inside a dead zone), which matches CapCut's "Stable" default.

5. **The 500-entry undo depth with full-entity records** (E §Undo/redo cursor). Each entry stores the whole `captions:<seqId>` entity twice. Every caption word edit therefore copies the entire override list, so history grows as O(edits × overrides).
   - **Change:** key caption overrides as their own entities (`captionOverride:<seqId>/<wordKey>`) in the normalised map.
   - **Side effect:** `undoRun` conflict detection becomes per word instead of per caption track. Today, any user caption edit makes an agent run's caption changes conflict.

6. **The quick-clip boundary rule** (E §Quick clips). Clips start at the sentence start, but a clip should start at the first word's start minus a small lead-in (e.g. 120 ms), not at a silent unit edge. It should also not begin within 2 frames before a shot cut. Breath and pause trimming at the edges needs (a)1.

7. **The loudness target is fixed and applied only after the mix** (E §Audio, §Audio QA). This is fine as a v1 default, but -14 LUFS integrated over a 30 s clip that contains SFX is dominated by the speech level. That is acceptable. The real risk is that per-source level differences go unhandled; see (a)6.

8. **Transitions with no overlap and `NO_HANDLES`** (E §Transitions). CapCut keeps transitions as separate materials as well ([C] `materials.transitions`), so our approach is consistent. The risk is quick clips: a source range placed as one item has no handles beyond `sourceRange`. A crossfade at the clip's edges will always fail, so default to cover-style transitions, which the spec already hints at.

### (c) Where we already match or beat CapCut

- **Crash safety.** Our design writes history first, with `fsync`, temp file plus rename, directory `fsync`, torn-line truncation and a cross-process `O_EXCL` lock (E §Write order). CapCut's evidence shows lifecycle `.bak` copies, `draft_status.json` and recycle-bin backups ([C] §2): a "copy and hope" model. Ours is stricter and testable (done-when #6).
- **Undoing an agent run, with conflict detection** (`undoRun`, E §Undo an agent run). CapCut's agent undoes by step count ([C] "requested steps"), and its group ids are per action. Our per-entity before/after check with `UNDO_CONFLICT` is more precise.
- **Captions derived from the transcript.** Captions are not stored as text segments. Trimming or moving clips never desyncs them (E §Captions). CapCut stores text segments and needs `SyncSubtitle*` and `subtitle_sync` APIs to repair them ([C]). Our `wordKey` that includes `transcriptRev` (orphans instead of misapplying) is better than CapCut's `is_relative_time` words.
- **Agent edits use the same typed ops as the UI**, validated by zod (E §Edit operations). This is equivalent to CapCut's `PatchJsonChecker` and Add/Remove/Update/Move ([C]), with stronger typing.
- **Audio QA and real-recording SFX rules** (E §Audio QA, S §SFX rules). No CapCut equivalent was found. Ducking is planned for v1.1 (E §Audio), and no ducking strings were found in CapCut ([I]), so we may lead there.
- **True-peak-aware loudness.** Our two-pass `loudnorm` with -1 dBTP and a limiter matches CapCut's `ebur128` and `true_peak_ceiling` approach ([C]).
- **Local and offline.** ASR (mlx-whisper), face tracking and clipping run locally. CapCut's international build has *no* local ASR ([C]), and its clipper and long-to-short flows are cloud-only ([C]).
- **Template contract.** JSON-Schema variables, `useWhen`, duration bounds, `sfxCues`, semver with migrate (S §template.json) are a cleaner contract for an LLM than CapCut's ScriptTemplate widget trees ([C] §7).
  - Worth copying: duration-adaptive entrance rules. CapCut skips the entrance animation under 2 s ([C] threshold `2000000`). Add an optional `minEntranceMs` to the template rules (S §Template rules).
- **Schema versioning with migrations** (E §Schema). This matches CapCut's Lua and C++ migrations ([C]). Adding the pre-migration snapshot from (a)7 completes it.

## 9. Limits of this analysis

- **Hidden values.** Bitrate tables, AED class names, highlight-scoring weights and the reframe smoothing math are computed at runtime, held server side or in encrypted models (`audio_metrics_v1.4.model`). They are not visible in the strings.
- **"Not found" is not "absent".** "Not found" claims (ducking, safe zones) are **[I]**.
- **Configs can change remotely.** Lyra service names and config keys may be remotely toggled. Their presence does not prove a feature ships in a given region.
- **Agent layer not covered here.** The agent layer (`libdeepagents_*`, agent tools) is covered by the separate agent-layer analysis.
