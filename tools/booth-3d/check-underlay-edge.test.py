import importlib.util
from pathlib import Path
import unittest
spec=importlib.util.spec_from_file_location('edge',Path(__file__).with_name('check-underlay-edge.py'))
edge=importlib.util.module_from_spec(spec)
spec.loader.exec_module(edge)
class EdgeTests(unittest.TestCase):
    def check_edge(self,offset):
        grey=[float(y>=60+offset) for y in range(200) for x in range(100)]
        return edge.measure(grey,100,200,{'front_top_edge_px':[[10,60],[90,60]],'booth_height_px':100})
    def test_bottom_up_buffer(self):
        raw=[1,1,1,1]*2+[0,0,0,1]*2
        self.assertEqual(edge.top_down_grey(raw,2,2),[0,0,1,1])
    def test_same_and_lower_accepted(self):
        for offset in (0,10,24):
            result=self.check_edge(offset)
            self.assertTrue(result['passed'])
            self.assertLessEqual(result['top_shift_percent'],0)
            self.assertAlmostEqual(result['top_shift_percent'],-offset,delta=1)
    def test_higher_positive_and_rejected(self):
        result=self.check_edge(-15)
        self.assertGreater(result['top_shift_percent'],5)
        self.assertFalse(result['passed'])
    def test_too_low_rejected(self):
        self.assertFalse(self.check_edge(30)['passed'])
    def test_blank_rejected(self):
        self.assertFalse(edge.measure([0]*20000,100,200,{'front_top_edge_px':[[10,60],[90,60]],'booth_height_px':100})['passed'])
if __name__=='__main__': unittest.main()
