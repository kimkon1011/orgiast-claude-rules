import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { ROOT } from '../lib/core.mjs';

test('installer selects linked physical MAC and validates exact disks; refuses ambiguous hardware', t => {
  if (spawnSync('python3', ['-c', 'import yaml']).status !== 0) return t.skip('python3-yaml required (Ubuntu validation)');
  const script = `
import importlib.util, pathlib, yaml
root=pathlib.Path(${JSON.stringify(ROOT)})
s=importlib.util.spec_from_file_location('installer',root/'bin/prepare-installer.py')
m=importlib.util.module_from_spec(s); s.loader.exec_module(m)
site={'hostname':'r640.example.test','adminSshKey':'ssh-ed25519 TEST','storageMode':'mdadm','diskSerials':['a','b'],'minimumDiskGiB':240}
nic=[dict(name='en1',wired=True,carrier=False,mac='00:11:22:33:44:01'),dict(name='en9',wired=True,carrier=True,mac='00:11:22:33:44:09'),dict(name='lo',wired=False,carrier=True,mac='00:00:00:00:00:00')]
disks=[dict(type='disk',rm=False,serial=x,size=256*1024**3,rota=False,tran='sata',path='/dev/'+x) for x in ['a','b']]
config=yaml.safe_load((root/'autoinstall/user-data').read_text())
r=m.prepare(config,site,disks,nic)
assert r['autoinstall']['network']['ethernets']['uplink']['match']=={'macaddress':'00:11:22:33:44:09'}
assert [x['path'] for x in r['autoinstall']['storage']['config'] if x['type']=='disk']==['/dev/a','/dev/b']
import unittest
case=unittest.TestCase()
with case.assertRaises(ValueError): m.choose_nic([])
with case.assertRaises(ValueError): m.storage_config(config['autoinstall']['storage']['config'],site,disks[:1])
site['storageMode']='hardware'
hw=yaml.safe_load((root/'autoinstall/user-data.hardware').read_text())
with case.assertRaises(ValueError): m.storage_config(hw['autoinstall']['storage']['config'],site,disks)
v=[dict(type='disk',rm=False,serial='VD',size=250*1024**3,model='PERC H730P',vendor='DELL',path='/dev/sdz')]
r=m.storage_config(hw['autoinstall']['storage']['config'],site,v)
assert r[0]['path']=='/dev/sdz'
`;
  const result = spawnSync('python3', ['-B', '-c', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});
