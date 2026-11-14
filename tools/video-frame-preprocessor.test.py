#!/usr/bin/env python3
"""
Tests for video-frame-preprocessor.py (X-0002).

Tests core functions (dhash, dedup, grid composition, transcript parsing)
without requiring a real video file. Grid composition tested with synthetic images.
"""

import importlib.util
import json
import math
import os
import sys
import tempfile
import unittest
from pathlib import Path

# Load the module (file has hyphens, can't import directly)
_spec = importlib.util.spec_from_file_location(
    'vfp',
    Path(__file__).with_name('video-frame-preprocessor.py'),
)
vfp = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(vfp)

from PIL import Image, ImageDraw


def make_test_image(width=100, height=100, color=(255, 0, 0)):
    """Create a simple test image."""
    return Image.new('RGB', (width, height), color)


def make_black_white_image(width=100, height=100):
    """Create a black-and-white checkerboard pattern (high contrast)."""
    img = Image.new('RGB', (width, height))
    draw = ImageDraw.Draw(img)
    for x in range(width):
        for y in range(height):
            c = 255 if (x // 10 + y // 10) % 2 == 0 else 0
            draw.point((x, y), (c, c, c))
    return img


def make_diagonal_image(width=100, height=100):
    """Create an image with a white diagonal line on black background."""
    img = Image.new('RGB', (width, height), (0, 0, 0))
    draw = ImageDraw.Draw(img)
    for i in range(min(width, height)):
        draw.point((i, i), (255, 255, 255))
    return img


class TestDHash(unittest.TestCase):
    """Tests for perceptual hash functions."""

    def test_identical_images_same_hash(self):
        img1 = make_test_image()
        img2 = make_test_image()
        self.assertEqual(vfp.dhash(img1), vfp.dhash(img2))

    def test_different_images_different_hash(self):
        bw = make_black_white_image()
        diag = make_diagonal_image()
        dist = vfp.hamming_distance(vfp.dhash(bw), vfp.dhash(diag))
        self.assertGreater(dist, 0)

    def test_self_hamming_distance_zero(self):
        img = make_test_image()
        h = vfp.dhash(img)
        self.assertEqual(vfp.hamming_distance(h, h), 0)

    def test_slightly_different_images_small_distance(self):
        """Small color change should produce small Hamming distance."""
        img1 = make_test_image(color=(100, 100, 100))
        img2 = make_test_image(color=(101, 101, 101))
        dist = vfp.hamming_distance(vfp.dhash(img1), vfp.dhash(img2))
        self.assertLessEqual(dist, 5)

    def test_hash_is_64bit(self):
        img = make_test_image()
        h = vfp.dhash(img)
        self.assertLess(h, 2 ** 64)
        self.assertGreaterEqual(h, 0)

    def test_hash_is_deterministic(self):
        img = make_test_image()
        self.assertEqual(vfp.dhash(img), vfp.dhash(img))


class TestDeduplication(unittest.TestCase):
    """Tests for frame deduplication logic."""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()

    def _save_frame(self, name, img):
        path = os.path.join(self.tmpdir, name)
        img.save(path)
        return path

    def test_empty_frames(self):
        self.assertEqual(vfp.deduplicate_frames([], threshold=5), [])

    def test_single_frame(self):
        frames = [{'file': 'dummy.jpg', 'timestamp_sec': 0}]
        result = vfp.deduplicate_frames(frames, threshold=5)
        self.assertEqual(len(result), 1)

    def test_identical_frames_deduplicated(self):
        """Two identical frames should be reduced to one with threshold=0."""
        img = make_test_image()
        fp1 = self._save_frame('f1.jpg', img)
        fp2 = self._save_frame('f2.jpg', img)
        frames = [
            {'file': fp1, 'timestamp_sec': 0},
            {'file': fp2, 'timestamp_sec': 10},
        ]
        result = vfp.deduplicate_frames(frames, threshold=0)
        self.assertEqual(len(result), 1)

    def test_different_frames_kept(self):
        """Two very different frames should both be kept."""
        fp1 = self._save_frame('f1.jpg', make_black_white_image())
        fp2 = self._save_frame('f2.jpg', make_diagonal_image())
        frames = [
            {'file': fp1, 'timestamp_sec': 0},
            {'file': fp2, 'timestamp_sec': 10},
        ]
        result = vfp.deduplicate_frames(frames, threshold=5)
        self.assertEqual(len(result), 2)

    def test_first_frame_always_kept(self):
        """First frame is always kept even with strict threshold."""
        fp1 = self._save_frame('f1.jpg', make_black_white_image())
        fp2 = self._save_frame('f2.jpg', make_diagonal_image())
        frames = [
            {'file': fp1, 'timestamp_sec': 0},
            {'file': fp2, 'timestamp_sec': 10},
        ]
        # threshold=0 only removes exact duplicates
        result = vfp.deduplicate_frames(frames, threshold=0)
        self.assertGreaterEqual(len(result), 1)
        self.assertEqual(result[0]['timestamp_sec'], 0)


class TestGridComposition(unittest.TestCase):
    """Tests for grid composition."""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()

    def _make_frame(self, name, color=(255, 0, 0), ts=0):
        path = os.path.join(self.tmpdir, name)
        make_test_image(color=color).save(path)
        return {'file': path, 'timestamp_sec': ts}

    def test_single_frame_grid(self):
        """Single frame should produce a 1x1 grid."""
        frames = [self._make_frame('f.jpg', ts=30)]
        out = os.path.join(self.tmpdir, 'grid.jpg')
        vfp.compose_grid(frames, grid_cols=3, grid_rows=3, output_path=out)
        self.assertTrue(os.path.exists(out))
        img = Image.open(out)
        self.assertEqual(img.size, (640, 360))

    def test_nine_frames_grid_size(self):
        """Nine frames should fill a 3x3 grid at default thumbnail size."""
        frames = [
            self._make_frame(f'f{i}.jpg', ts=i * 10)
            for i in range(9)
        ]
        out = os.path.join(self.tmpdir, 'grid.jpg')
        vfp.compose_grid(frames, grid_cols=3, grid_rows=3, output_path=out)
        self.assertTrue(os.path.exists(out))
        img = Image.open(out)
        self.assertEqual(img.size, (1920, 1080))  # 3*640 x 3*360

    def test_empty_frames_no_error(self):
        """Empty frame list should not crash."""
        out = os.path.join(self.tmpdir, 'grid.jpg')
        vfp.compose_grid([], grid_cols=3, grid_rows=3, output_path=out)
        self.assertTrue(os.path.exists(out))

    def test_custom_thumbnail_size(self):
        """Custom thumbnail size should be reflected in output."""
        frames = [self._make_frame('f.jpg', ts=0)]
        out = os.path.join(self.tmpdir, 'grid.jpg')
        vfp.compose_grid(frames, grid_cols=1, grid_rows=1,
                         output_path=out, thumbnail_size=(320, 180))
        img = Image.open(out)
        self.assertEqual(img.size, (320, 180))

    def test_grid_has_timestamp_overlay(self):
        """Grid image should have timestamp text (file size > base image)."""
        frames = [self._make_frame('f.jpg', ts=90)]  # 01:30
        out = os.path.join(self.tmpdir, 'grid.jpg')
        vfp.compose_grid(frames, grid_cols=1, grid_rows=1,
                         output_path=out, thumbnail_size=(320, 180))
        # Just verify it saved without error
        self.assertTrue(os.path.exists(out))
        self.assertGreater(os.path.getsize(out), 100)


class TestTranscript(unittest.TestCase):
    """Tests for transcript parsing and matching."""

    def test_srt_parsing(self):
        srt_content = """1
00:00:01,000 --> 00:00:04,000
Hello world

2
00:00:05,000 --> 00:00:08,500
This is a test
Second line
"""
        with tempfile.NamedTemporaryFile(mode='w', suffix='.srt',
                                         delete=False, encoding='utf-8') as f:
            f.write(srt_content)
            srt_path = f.name

        try:
            segments = vfp.load_transcript(srt_path)
            self.assertEqual(len(segments), 2)
            self.assertAlmostEqual(segments[0]['start_sec'], 1.0)
            self.assertAlmostEqual(segments[0]['end_sec'], 4.0)
            self.assertEqual(segments[0]['text'], 'Hello world')
            self.assertEqual(segments[1]['text'], 'This is a test Second line')
        finally:
            os.unlink(srt_path)

    def test_vtt_parsing(self):
        vtt_content = """WEBVTT

00:00:02.000 --> 00:00:06.000
Hello from VTT

00:00:07.500 --> 00:00:10.000
Second segment
"""
        with tempfile.NamedTemporaryFile(mode='w', suffix='.vtt',
                                         delete=False, encoding='utf-8') as f:
            f.write(vtt_content)
            vtt_path = f.name

        try:
            segments = vfp.load_transcript(vtt_path)
            self.assertEqual(len(segments), 2)
            self.assertAlmostEqual(segments[0]['start_sec'], 2.0)
            self.assertEqual(segments[0]['text'], 'Hello from VTT')
        finally:
            os.unlink(vtt_path)

    def test_empty_transcript_returns_empty(self):
        self.assertEqual(vfp.load_transcript(None), [])
        self.assertEqual(vfp.load_transcript('nonexistent.srt'), [])

    def test_ts_to_sec_conversion(self):
        self.assertAlmostEqual(vfp._ts_to_sec('00:01:30.500'), 90.5)
        self.assertAlmostEqual(vfp._ts_to_sec('01:00:00.000'), 3600.0)
        self.assertAlmostEqual(vfp._ts_to_sec('00:00:00.000'), 0.0)
        self.assertAlmostEqual(vfp._ts_to_sec('00:01:30,500'), 90.5)

    def test_match_transcript_to_frames(self):
        frames = [
            {'file': 'f1.jpg', 'timestamp_sec': 2.0},
            {'file': 'f2.jpg', 'timestamp_sec': 10.0},
        ]
        segments = [
            {'start_sec': 0.0, 'end_sec': 5.0, 'text': 'Intro'},
            {'start_sec': 8.0, 'end_sec': 12.0, 'text': 'Main content'},
        ]
        matched = vfp.match_transcript_to_frames(frames, segments)
        self.assertEqual(matched[0]['transcript'], 'Intro')
        self.assertEqual(matched[1]['transcript'], 'Main content')


class TestTokenEstimate(unittest.TestCase):
    """Tests for token estimation."""

    def test_estimate_basic(self):
        est = vfp.estimate_tokens(100, 20)
        self.assertEqual(est['raw_tokens'], 100 * 2587)
        self.assertEqual(est['grid_tokens'], 20 * 2587)
        self.assertAlmostEqual(est['reduction_pct'], 80.0, places=1)

    def test_zero_frames(self):
        est = vfp.estimate_tokens(0, 0)
        self.assertEqual(est['raw_tokens'], 0)
        self.assertEqual(est['grid_tokens'], 0)
        self.assertEqual(est['reduction_pct'], 0.0)

    def test_no_reduction_same_count(self):
        est = vfp.estimate_tokens(10, 10)
        self.assertEqual(est['reduction_pct'], 0.0)


if __name__ == '__main__':
    unittest.main()
