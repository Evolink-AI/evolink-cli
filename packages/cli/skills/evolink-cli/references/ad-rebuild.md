# Ad Rebuild workflow

Rebuild a reference ad as a new ad with the user's own product and creator. The structure, hook and rhythm stay; the person, product, room, words and music are new. The result is one finished vertical video with sound, generated in a single video task and delivered with a keyframe contact sheet, a brief summary of the checks, any important open issues, and the cost: the estimate and the actual charge. Give shot-by-shot verdicts only when the user asks for them.

Name it Ad Rebuild when you speak English with the user and 广告复刻 when you speak Chinese, and keep one name for the whole conversation. The user's source video is the reference ad; it is not what this workflow is called.

This page is only the entry point. EvoLink sends the working rules for each step after login. Fetch them with `evolink workflow rules ad-rebuild --json` and follow them; do not improvise the steps from this page.

## What you need from the user

- The reference ad: a video of 30 seconds or less. If it is longer, ask for a segment of 30 seconds or less.
- Product images, one line on what the product does, and which claims are verified.
- A creator photo if a specific person should appear. Without one, a fictional adult creator is prepared when the ad needs a person.
- Choices that cannot be inferred: language, on-camera speech or voiceover, music, aspect ratio and length (up to 30 seconds). Do not ask for the resolution up front: without one, the estimate is made for 720p, and 480p, 1080p, 4K or a 480p draft first are offered next to it.

The user must own the product and creator material or have the rights to use it.

## Before you start

- The CLI must be logged in: `evolink balance --json` succeeds. If it reports `login_required`, ask the user to run `evolink auth login`, then stop until it is done.
- If `evolink workflow rules ad-rebuild --json` reports `workflow_unavailable`, the workflow is not offered for this login yet. Say so and stop.
- Never ask for an API key. Charges go to the logged-in account.
- Frames, crops and contact sheets: use local ffmpeg and ffprobe. If they are missing, ask before installing them.

## Commands

The rules name EvoLink tools. With the CLI, run these commands instead:

| The rules say | Run |
|---|---|
| `get_media_workflow` | `evolink workflow rules ad-rebuild [--section ID] --run RUN_ID --json` (leave `--run` out only on the first call) |
| `get_media_workflow` with `estimate` | `evolink workflow estimate ad-rebuild --run RUN_ID --seconds N --keyframes N [--quality 480p\|720p\|1080p\|4k] [--aspect-ratio 9:16] [--creator-images N] --json` |
| `analyze_video` | `evolink video analyze FILE_URL --run RUN_ID --step STEP --purpose breakdown\|sound\|compare [--target-file FILE] [--attempt N] --json` |
| `get_video_analysis` | `evolink video analysis ANALYSIS_ID --json` |
| `upload_file`, `prepare_upload` | `evolink upload /absolute/path --json` |
| `search_models`, `get_model` | `evolink models search --query TEXT --json`, `evolink models show MODEL --json` |
| `record_workflow_delivery` | Once a completed video is chosen for delivery, run `evolink workflow deliver TASK_ID --run RUN_ID --json`. |
| `generate_workflow_media` | Bind each workflow generation with `evolink estimate --model MODEL --input-file FILE --run RUN_ID --step STEP --json`. Submit the approved quote with `evolink generate image\|video\|audio --quote ID --confirm --json`. Refresh and resume keep the original binding. |
| `estimate_cost` | `evolink estimate --model MODEL --input-file FILE --json` |
| `generate_image`, `generate_video`, `generate_audio` | `evolink generate image\|video\|audio --quote ID --confirm --json` |
| `get_task`, `list_tasks` | `evolink tasks get\|wait\|list\|batch ... --json` |
| `check_balance` | `evolink balance --json` |
| `make_frames` | not in the CLI: use local ffmpeg |

The first `workflow rules` answer returns a `run_id` and the list of sections. Pass that `run_id` with `--run` on every later `workflow` and `video` command of the same rebuild, and fetch each section when you reach its step.

For a comparison (`--purpose compare`), write the whole-ad target sheet and timeline to a text file and pass it with `--target-file`.

## Steps

0. Check inputs and confirm the cost
1. Read the reference
2. Write the target
3. Plan the whole ad
4. Build and check all keyframes
5. Build the complete video input
6. Generate and check
7. Deliver

## Cost: one estimate, one confirmation

- Before the user confirms, do only free work: login and balance, the reference's duration and aspect ratio, frames and shot count, rules and prices. `workflow rules` and `workflow estimate` are free. `video analyze` is paid.
- Present the one estimated total from `workflow estimate` and what it covers, and ask once. The total depends mostly on the length and resolution of the video. If the user named no resolution, estimate with `--quality 720p` and list the other choices after that total; when the user picks one of them, run `workflow estimate` again with it (free) and present that single total instead. Charges are then made step by step as the work runs.
- That confirmation is the approval for the quotes inside the total: after it, estimate each generation and submit it with `--confirm` without asking again, as long as the running total stays within the estimate.
- Ask again only when the total would be exceeded, when a decision is the user's, when the finished ad needs a new attempt, or, on the draft route, once the draft is delivered: then ask whether to convert it to 1080p or 4K. Estimate and confirm each conversion on its own; it is not part of the total, so the confirmation above does not cover it.
- If the client can show a question with answers to pick, ask through it: the suggested answer first, and room for the user to type a different one. Otherwise ask in one short message.
- At delivery, show the actual charge next to the estimated total. If the user wants detail, break the charge down by task; they can also list their tasks with `evolink tasks list --json`, or sign in to the dashboard with the same EvoLink account, where every call is listed: https://evolink.ai/dashboard

## If something stops the run

- **Balance too low.** Nothing is charged for the refused step. Give the top-up link from the error. After the user tops up, continue from the same step; finished steps are reused.
- **A generation fails.** It is not charged. Retry at most twice for a temporary failure, then stop and explain.
- **A video read fails.** Follow the next step in the error. Repeat exactly the same command when it says so: a finished read is returned without a new charge. Add `--attempt 2` only when the error says to raise the attempt.
- **The terminal or the conversation restarts.** Fetch the rules again with the same `--run`, and look for submitted tasks with `evolink tasks list --json` before submitting anything again. Result links and uploads stay available for 7 days.

## Rights and limits

- The reference guides structure only. The new ad must not show the reference's people, faces, clothing, room, brand or audio.
- Do not invent logos, prices, statistics or product claims. Use only claims the user confirmed.
- Some image and video models refuse inputs that look like real people. Report a refusal; never reword a prompt to get past review.
- One creator and one product per run unless the user asks otherwise.

For acceptance of an EvoLink video task, pass its task ID as the video argument to `evolink video analyze`. For an uploaded reference, pass the file link.
