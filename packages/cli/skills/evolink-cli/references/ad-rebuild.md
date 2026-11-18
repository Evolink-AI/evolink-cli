# Ad Rebuild workflow

Rebuild a reference ad as a new ad with the user's own product and creator. The structure, hook and rhythm stay; the person, product, room, words and music are new. The result is one finished vertical video with sound, generated in a single video task and delivered with a keyframe contact sheet, a verdict for every shot and the total cost.

Name it Ad Rebuild when you speak English with the user and 广告复刻 when you speak Chinese, and keep one name for the whole conversation. The user's source video is the reference ad; it is not what this workflow is called.

This page is only the entry point. EvoLink sends the working rules for each step after login. Fetch them with `evolink workflow rules ad-rebuild --json` and follow them; do not improvise the steps from this page.

## What you need from the user

- The reference ad: a video of 30 seconds or less. If it is longer, ask for a segment of 30 seconds or less.
- Product images, one line on what the product does, and which claims are verified.
- A creator photo if a specific person should appear. Without one, a fictional adult creator is prepared when the ad needs a person.
- Choices that cannot be inferred: language, on-camera speech or voiceover, music, aspect ratio, length (up to 30 seconds) and resolution.

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
| `get_media_workflow` with `estimate` | `evolink workflow estimate ad-rebuild --run RUN_ID --seconds N --keyframes N [--quality 720p] [--aspect-ratio 9:16] [--creator-images N] --json` |
| `analyze_video` | `evolink video analyze FILE_URL --run RUN_ID --step STEP --purpose breakdown\|sound\|compare [--target-file FILE] [--attempt N] --json` |
| `get_video_analysis` | `evolink video analysis ANALYSIS_ID --json` |
| `upload_file`, `prepare_upload` | `evolink upload /absolute/path --json` |
| `search_models`, `get_model` | `evolink models search --query TEXT --json`, `evolink models show MODEL --json` |
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
- Present the one estimated total from `workflow estimate` and what it covers, and ask once. The total depends mostly on the length and resolution of the video. Charges are then made step by step as the work runs.
- That confirmation is the approval for the quotes inside the total: after it, estimate each generation and submit it with `--confirm` without asking again, as long as the running total stays within the estimate.
- Ask again only when the total would be exceeded, when a decision is the user's, or when the finished ad needs a new attempt.
- If the user asks what the total includes, say the total and what it covers. Every call is listed in the dashboard history: https://evolink.ai/dashboard

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
