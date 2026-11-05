"""Sobel screening: top-left coordinates, negative shift means a LOWER roof.

This screens one edge, not the whole silhouette. Visually inspect accepted images.
"""
import json
import math
import os
import sys


def top_down_grey(raw, width, height):
    # Blender image buffers start at bottom-left; metadata starts at top-left.
    return [sum(weight * raw[((height - 1 - y) * width + x) * 4 + c]
                for c, weight in enumerate((.2126, .7152, .0722)))
            for y in range(height) for x in range(width)]


def measure(grey, width, height, meta):
    edge = meta['front_top_edge_px']
    x0 = max(2, round(min(p[0] for p in edge)))
    x1 = min(width - 3, round(max(p[0] for p in edge)))
    booth_height = meta['booth_height_px']
    if x1 <= x0 or booth_height <= 0:
        raise ValueError('Invalid projected edge or booth height')
    expected = sum(p[1] for p in edge) / 2
    radius = max(10, round(booth_height * .45))

    def score(offset):
        total = 0
        for x in range(x0, x1 + 1):
            y = round(edge[0][1] + (edge[1][1] - edge[0][1]) *
                      (x - edge[0][0]) / (edge[1][0] - edge[0][0]) + offset)
            if not 1 <= y < height - 1:
                return -1
            def pixel(dx, dy):
                return grey[(y + dy) * width + x + dx]
            gx = pixel(1,-1) + 2*pixel(1,0) + pixel(1,1) - pixel(-1,-1) - 2*pixel(-1,0) - pixel(-1,1)
            gy = pixel(-1,1) + 2*pixel(0,1) + pixel(1,1) - pixel(-1,-1) - 2*pixel(0,-1) - pixel(1,-1)
            total += math.hypot(gx, gy)
        return total / (x1 - x0 + 1)

    offset = max(range(-radius, radius+1), key=lambda d: (score(d), -abs(d)))
    strength = score(offset)
    shift = -offset / booth_height * 100
    boundary = abs(offset) == radius
    return {
        'expected_top_y_px': expected, 'detected_top_y_px': expected + offset,
        'top_shift_percent': shift, 'threshold_percent': {'min': -25, 'max': 5},
        'sobel_score': strength,
        'passed': -25 <= shift <= 5 and not boundary and strength > 1e-6,
        'search_x_px': [x0,x1], 'coordinate_origin': 'top-left',
        'sign_convention': 'negative=lower,positive=higher',
        'at_search_boundary': boundary, 'requires_visual_review': True,
    }


def main(args):
    import bpy
    base_path,candidate_path,meta_path,result_path,comparison_path = map(os.path.abspath,args[:5])
    with open(meta_path,encoding='utf-8') as handle:
        meta=json.load(handle)
    base=bpy.data.images.load(base_path,check_existing=False)
    candidate=bpy.data.images.load(candidate_path,check_existing=False)
    width,height=base.size
    if (width,height)!=(meta['width'],meta['height']):
        raise ValueError('Underlay size does not match projection metadata')
    # Resize only in memory. Never overwrite the generated image.
    if tuple(candidate.size)!=(width,height):
        candidate.scale(width,height)
    left,right=list(base.pixels[:]),list(candidate.pixels[:])
    result=measure(top_down_grey(right,width,height),width,height,meta)
    with open(result_path,'w',encoding='utf-8') as handle:
        json.dump(result,handle,ensure_ascii=False,indent=2)
    comparison=bpy.data.images.new('comparison',width=width*2,height=height,alpha=True)
    pixels=[]
    for row in range(height):
        start,end=row*width*4,(row+1)*width*4
        pixels.extend(left[start:end]); pixels.extend(right[start:end])
    comparison.pixels[:]=pixels
    comparison.filepath_raw=comparison_path
    comparison.file_format='PNG'
    comparison.save()
    print(json.dumps(result,ensure_ascii=False))
    return 0 if result['passed'] else 2


if __name__=='__main__':
    sys.exit(main(sys.argv[sys.argv.index('--')+1:]))
