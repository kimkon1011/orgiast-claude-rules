#!/usr/bin/env python3
"""
X-0002: Video Frame Preprocessor for Gemini Token Reduction

Converts video to frame images, deduplicates via perceptual hash (dHash),
composes 3x3 grids with timestamp overlays, optionally matches against
transcript, and outputs metadata JSON for Gemini consumption.

Usage:
  python tools/video-frame-preprocessor.py input.mp4
  python tools/video-frame-preprocessor.py input.mp4 --interval 30 --threshold 3
  python tools/video-frame-preprocessor.py input.mp4 --transcript captions.srt
  python tools/video-frame-preprocessor.py input.mp4 --output-dir ./frames --no-dedup

Token savings (1h video, interval=10s, threshold=5):
  Raw frames: 360 × 2587 tokens ≈ 931K tokens
  After dedup+grid (est. 40-80 grids): 40-80 × 2587 ≈ 103-207K tokens
  Reduction: ~78-89%

Dependencies: Pillow, imageio-ffmpeg (or ffmpeg on PATH)
"""

import argparse
import json
import math
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont


# ─── Perceptual Hashing (dHash) ───────────────────────────────────────────

def dhash(image, hash_size=8):
    """Compute difference hash of an image. Returns 64-bit int."""
    img = image.convert('L').resize((hash_size + 1, hash_size), Image.LANCZOS)
    bits = []
    for row in range(hash_size):
        for col in range(hash_size):
            bits.append(img.getpixel((col, row)) > img.getpixel((col + 1, row)))
    return sum((bit << i) for i, bit in enumerate(bits))


def hamming_distance(h1, h2):
    """Compute Hamming distance (number of differing bits)."""
    xor = h1 ^ h2
    return bin(xor).count('1')


# ─── Frame Extraction ─────────────────────────────────────────────────────

def get_ffmpeg_path():
    """Get ffmpeg binary path from imageio_ffmpeg, else hope on PATH."""
    try:
        import imageio_ffmpeg  # noqa: F811
        return imageio_ffmpeg.get_ffmpeg_exe()
    except (ImportError, RuntimeError):
        return 'ffmpeg'


def get_video_duration(video_path):
    """Get video duration in seconds using ffprobe/ffmpeg."""
    ffmpeg = get_ffmpeg_path()
    probe = subprocess.run(
        [ffmpeg, '-i', video_path, '-f', 'null', '-'],
        capture_output=True, text=True, stderr=subprocess.PIPE,
    )
    dur_match = re.search(
        r'Duration: (\d+):(\d+):(\d+)\.(\d+)', probe.stderr
    )
    if not dur_match:
        raise RuntimeError(f"Cannot parse duration from ffmpeg output")
    h, m, s, ms = map(int, dur_match.groups())
    return h * 3600 + m * 60 + s + ms / 100.0


def extract_frames(video_path, interval_sec=10, output_dir=None, quality=5):
    """
    Extract frames from video at regular intervals using ffmpeg.

    Args:
        video_path: Path to input video file.
        interval_sec: Seconds between extracted frames.
        output_dir: Output directory (auto temp dir if None).
        quality: JPEG quality 1-31 (lower=better, default 5).

    Returns:
        Tuple of (frames_list, total_duration_seconds).
        Each frame dict: {'file': str, 'timestamp_sec': float}
    """
    ffmpeg = get_ffmpeg_path()
    if output_dir is None:
        output_dir = tempfile.mkdtemp(prefix='video-frames-')
    else:
        os.makedirs(output_dir, exist_ok=True)

    total_seconds = get_video_duration(video_path)

    output_pattern = os.path.join(output_dir, 'frame_%05d.jpg')
    cmd = [
        ffmpeg, '-i', video_path,
        '-vf', f'fps=1/{interval_sec}',
        '-qscale:v', str(quality),
        '-y', output_pattern,
    ]
    subprocess.run(cmd, capture_output=True, text=True, check=True)

    frame_files = sorted([
        os.path.join(output_dir, f) for f in os.listdir(output_dir)
        if f.startswith('frame_') and f.endswith('.jpg')
    ])

    frames = []
    for i, fp in enumerate(frame_files):
        ts = (i + 1) * interval_sec
        if ts > total_seconds:
            ts = total_seconds
        frames.append({'file': fp, 'timestamp_sec': ts})

    return frames, total_seconds


# ─── Deduplication ────────────────────────────────────────────────────────

def deduplicate_frames(frames, threshold=5):
    """
    Remove frames too similar to the previous kept frame.
    Uses dHash with Hamming distance threshold (0-64).

    Lower threshold = stricter dedup (more frames removed).
    threshold=0: only exact duplicates kept.
    threshold=64: no dedup.
    """
    if not frames or len(frames) <= 1:
        return frames

    result = [frames[0]]
    prev_hash = dhash(Image.open(frames[0]['file']))

    for frame in frames[1:]:
        img = Image.open(frame['file'])
        h = dhash(img)
        dist = hamming_distance(prev_hash, h)
        if dist > threshold:
            result.append(frame)
            prev_hash = h

    return result


# ─── Grid Composition ─────────────────────────────────────────────────────

def compose_grid(frames, grid_cols=3, grid_rows=3, output_path='grid.jpg',
                 thumbnail_size=(640, 360), font_size=24):
    """
    Compose frames into a grid with timestamp overlays.

    Args:
        frames: List of frame dicts with 'file' and 'timestamp_sec'.
        grid_cols: Number of columns in the grid.
        grid_rows: Number of rows in the grid.
        output_path: Output image path.
        thumbnail_size: (width, height) for each thumbnail.
        font_size: Font size for timestamp overlay.

    Returns:
        Output file path.
    """
    n = len(frames)
    if n == 0:
        # Create an empty placeholder grid
        grid_img = Image.new('RGB', (thumbnail_size[0], thumbnail_size[1]), (32, 32, 32))
        grid_img.save(output_path, 'JPEG', quality=85)
        return output_path
    cols = min(grid_cols, n)
    rows = min(grid_rows, max(1, math.ceil(n / cols)))

    grid_w = cols * thumbnail_size[0]
    grid_h = rows * thumbnail_size[1]

    grid_img = Image.new('RGB', (grid_w, grid_h), (32, 32, 32))
    draw = ImageDraw.Draw(grid_img)

    try:
        font = ImageFont.truetype("arial.ttf", font_size)
    except (IOError, OSError):
        font = ImageFont.load_default()

    for i, frame_info in enumerate(frames):
        if i >= cols * rows:
            break

        img = Image.open(frame_info['file'])
        img.thumbnail(thumbnail_size, Image.LANCZOS)

        col = i % cols
        row = i // cols
        x = col * thumbnail_size[0]
        y = row * thumbnail_size[1]

        # Center the thumbnail in its cell if smaller
        paste_x = x + (thumbnail_size[0] - img.width) // 2
        paste_y = y + (thumbnail_size[1] - img.height) // 2
        grid_img.paste(img, (paste_x, paste_y))

        # Timestamp overlay (semi-transparent background)
        ts = frame_info['timestamp_sec']
        ts_str = f"{int(ts // 60):02d}:{int(ts % 60):02d}"
        bbox = draw.textbbox((0, 0), ts_str, font=font)
        tw = bbox[2] - bbox[0] + 10
        th = bbox[3] - bbox[1] + 6
        overlay = Image.new('RGBA', (tw, th), (0, 0, 0, 180))
        grid_img.paste(overlay, (x + 4, y + 4), overlay)
        draw.text((x + 8, y + 6), ts_str, fill=(255, 255, 255), font=font)

        # Transcript overlay if available
        transcript = frame_info.get('transcript', '')
        if transcript and len(transcript) < 80:
            tx_bbox = draw.textbbox((0, 0), transcript, font=font)
            tx_w = tx_bbox[2] - tx_bbox[0] + 10
            tx_h = tx_bbox[3] - tx_bbox[1] + 6
            tx_overlay = Image.new('RGBA', (tx_w, tx_h), (0, 0, 0, 160))
            grid_img.paste(
                tx_overlay,
                (x + 4, y + thumbnail_size[1] - tx_h - 4),
                tx_overlay,
            )
            draw.text(
                (x + 8, y + thumbnail_size[1] - tx_h - 2),
                transcript, fill=(200, 255, 200), font=font,
            )

    # Draw grid separator lines
    sep_color = (64, 64, 64)
    for col in range(1, cols):
        lx = col * thumbnail_size[0]
        draw.line([(lx, 0), (lx, grid_h)], fill=sep_color, width=1)
    for row in range(1, rows):
        ly = row * thumbnail_size[1]
        draw.line([(0, ly), (grid_w, ly)], fill=sep_color, width=1)

    grid_img.save(output_path, 'JPEG', quality=85)
    return output_path


# ─── Transcript Integration ───────────────────────────────────────────────

def load_transcript(transcript_path):
    """
    Load transcript/subtitle file and return segments with timestamps.

    Supports SRT and VTT formats. Returns list of dicts:
      {'start_sec': float, 'end_sec': float, 'text': str}
    """
    if not transcript_path or not os.path.exists(transcript_path):
        return []

    with open(transcript_path, 'r', encoding='utf-8') as f:
        content = f.read()

    # Try SRT format: index + timestamp --> timestamp + text
    srt_pattern = re.compile(
        r'\d+\n'
        r'(\d{2}:\d{2}:\d{2}[.,]\d{3}) --> (\d{2}:\d{2}:\d{2}[.,]\d{3})\n'
        r'(.+?)(?=\n\n|\Z)',
        re.DOTALL,
    )
    matches = srt_pattern.findall(content)
    if matches:
        return [
            {
                'start_sec': _ts_to_sec(start),
                'end_sec': _ts_to_sec(end),
                'text': text.strip().replace('\n', ' '),
            }
            for start, end, text in matches
        ]

    # Try VTT format: timestamp --> timestamp
    vtt_pattern = re.compile(
        r'(\d{2}:\d{2}:\d{2}[.,]\d{3}) --> (\d{2}:\d{2}:\d{2}[.,]\d{3})\n'
        r'(.+?)(?=\n\n|\Z)',
        re.DOTALL,
    )
    matches = vtt_pattern.findall(content)
    if matches:
        return [
            {
                'start_sec': _ts_to_sec(start),
                'end_sec': _ts_to_sec(end),
                'text': text.strip().replace('\n', ' '),
            }
            for start, end, text in matches
        ]

    return []


def _ts_to_sec(t):
    """Convert SRT/VTT timestamp (HH:MM:SS.mmm) to seconds."""
    t = t.replace(',', '.')
    parts = t.split(':')
    if len(parts) == 3:
        return int(parts[0]) * 3600 + int(parts[1]) * 60 + float(parts[2])
    return 0


def match_transcript_to_frames(frames, segments):
    """Associate transcript text with frame timestamps."""
    for frame in frames:
        ts = frame['timestamp_sec']
        matching = [
            seg['text'] for seg in segments
            if seg['start_sec'] <= ts <= seg['end_sec']
        ]
        frame['transcript'] = ' '.join(matching) if matching else ''
    return frames


# ─── Token Estimation ─────────────────────────────────────────────────────

def estimate_tokens(num_frames, num_grids):
    """
    Estimate Gemini token consumption.

    Gemini 1.5 Pro: ~2587 tokens per 3072×3072 image.
    Each grid image counts as one image token block.
    """
    tokens_per_image = 2587
    raw_tokens = num_frames * tokens_per_image
    grid_tokens = num_grids * tokens_per_image
    reduction_pct = (
        ((raw_tokens - grid_tokens) / raw_tokens * 100)
        if raw_tokens > 0 else 0
    )
    return {
        'raw_tokens': raw_tokens,
        'grid_tokens': grid_tokens,
        'reduction_pct': round(reduction_pct, 1),
    }


# ─── Main Pipeline ────────────────────────────────────────────────────────

def build_pipeline(args):
    """Run the full preprocessing pipeline."""
    os.makedirs(args.output_dir, exist_ok=True)

    # Step 1: Extract frames
    print(f"[1/4] Extracting frames every {args.interval}s...")
    frames, duration = extract_frames(
        args.video,
        interval_sec=args.interval,
        output_dir=args.output_dir,
        quality=args.quality,
    )
    print(f"      → {len(frames)} frames from {duration:.1f}s video")

    # Step 2: Load transcript
    transcript_segments = load_transcript(args.transcript)
    if transcript_segments:
        print(f"      → Transcript: {len(transcript_segments)} segments")
        frames = match_transcript_to_frames(frames, transcript_segments)
    else:
        print(f"      → No transcript loaded")

    # Step 3: Deduplicate
    if not args.no_dedup and len(frames) > 1:
        orig_count = len(frames)
        frames = deduplicate_frames(frames, threshold=args.threshold)
        removed = orig_count - len(frames)
        print(f"[2/4] Dedup: {orig_count} → {len(frames)} "
              f"(removed {removed}, threshold={args.threshold})")
    else:
        print(f"[2/4] Dedup skipped")

    # Step 4: Compose grids
    grid_size = args.grid_cols * args.grid_rows
    num_grids = math.ceil(len(frames) / grid_size)
    print(f"[3/4] Composing {num_grids} grids ({args.grid_cols}x{args.grid_rows})...")

    grid_files = []
    for g in range(num_grids):
        start = g * grid_size
        end = min(start + grid_size, len(frames))
        batch = frames[start:end]
        grid_path = os.path.join(
            args.output_dir, f'grid_{g:04d}.jpg'
        )
        compose_grid(
            batch,
            grid_cols=args.grid_cols,
            grid_rows=args.grid_rows,
            output_path=grid_path,
            thumbnail_size=(
                args.thumbnail_width,
                args.thumbnail_width * 9 // 16,
            ),
            font_size=args.font_size,
        )
        grid_files.append(grid_path)

    # Step 5: Generate metadata
    print(f"[4/4] Generating metadata...")
    token_est = estimate_tokens(
        len(frames) + len(frames) // grid_size, num_grids
    )
    metadata = {
        'pipeline': 'X-0002 video-preprocess',
        'generated_at': __import__('datetime').datetime.now().isoformat(),
        'source_video': args.video,
        'duration_sec': duration,
        'extraction_interval_sec': args.interval,
        'dedup_threshold': args.threshold if not args.no_dedup else None,
        'grid_layout': f"{args.grid_cols}x{args.grid_rows}",
        'total_unique_frames': len(frames),
        'total_grids': num_grids,
        'thumbnail_width': args.thumbnail_width,
        'has_transcript': len(transcript_segments) > 0,
        'token_estimate': token_est,
        'grids': [],
    }

    for g_idx, grid_path in enumerate(grid_files):
        start = g_idx * grid_size
        end = min(start + grid_size, len(frames))
        batch = frames[start:end]
        metadata['grids'].append({
            'file': os.path.basename(grid_path),
            'frames': [
                {
                    'timestamp_sec': f['timestamp_sec'],
                    'timestamp': (
                        f"{int(f['timestamp_sec'] // 60):02d}:"
                        f"{int(f['timestamp_sec'] % 60):02d}"
                    ),
                    'transcript': f.get('transcript', ''),
                }
                for f in batch
            ],
        })

    meta_path = os.path.join(args.output_dir, 'metadata.json')
    with open(meta_path, 'w', encoding='utf-8') as f:
        json.dump(metadata, f, indent=2, ensure_ascii=False)

    print(f"\n✅ Complete: {num_grids} grids, {len(frames)} unique frames")
    print(f"   Grid images: {args.output_dir}/grid_*.jpg")
    print(f"   Metadata: {meta_path}")
    print(f"   Token est: {token_est['grid_tokens']:,} tokens "
          f"(raw: {token_est['raw_tokens']:,}, "
          f"-{token_est['reduction_pct']}%)")

    # JSON summary for Node.js wrapper
    summary = {
        'status': 'ok',
        'grids': num_grids,
        'grid_files': [os.path.basename(g) for g in grid_files],
        'metadata_file': 'metadata.json',
        'unique_frames': len(frames),
        'total_grids': num_grids,
        'token_estimate': token_est,
        'output_dir': args.output_dir,
    }
    print(f"\n---SUMMARY---")
    print(json.dumps(summary))
    print(f"---ENDSUMMARY---")

    return summary


def main():
    parser = argparse.ArgumentParser(
        description=(
            'X-0002: Video Frame Preprocessor for Gemini Token Reduction. '
            'Extracts frames, deduplicates, composes 3x3 grids with '
            'timestamps, and outputs metadata JSON.'
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            'Examples:\n'
            '  %(prog)s input.mp4\n'
            '  %(prog)s input.mp4 --interval 30 --threshold 3\n'
            '  %(prog)s input.mp4 --transcript captions.srt\n'
            '  %(prog)s input.mp4 --output-dir ./frames --no-dedup\n'
        ),
    )
    parser.add_argument('video', help='Input video file path')
    parser.add_argument(
        '--output-dir', '-o', default='./gemini-grids',
        help='Output directory for grid images and metadata',
    )
    parser.add_argument(
        '--interval', '-i', type=int, default=10,
        help='Frame extraction interval in seconds (default: 10)',
    )
    parser.add_argument(
        '--threshold', '-t', type=int, default=5,
        help='dHash dedup threshold 0-64 (lower=stricter, default: 5)',
    )
    parser.add_argument(
        '--grid-cols', type=int, default=3,
        help='Grid columns (default: 3)',
    )
    parser.add_argument(
        '--grid-rows', type=int, default=3,
        help='Grid rows (default: 3)',
    )
    parser.add_argument(
        '--transcript', '-s',
        help='Transcript/subtitle file (SRT/VTT format)',
    )
    parser.add_argument(
        '--no-dedup', action='store_true',
        help='Skip frame deduplication',
    )
    parser.add_argument(
        '--quality', type=int, default=5,
        help='JPEG quality 1-31 for ffmpeg (lower=better, default: 5)',
    )
    parser.add_argument(
        '--thumbnail-width', type=int, default=640,
        help='Thumbnail width in pixels (default: 640)',
    )
    parser.add_argument(
        '--font-size', type=int, default=20,
        help='Font size for timestamp overlay (default: 20)',
    )

    args = parser.parse_args()

    if not os.path.exists(args.video):
        print(f"Error: Video file not found: {args.video}", file=sys.stderr)
        sys.exit(1)

    try:
        build_pipeline(args)
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
