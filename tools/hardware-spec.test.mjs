import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSpecPayload, classifyDisk, classifyNetworkAdapters, classifyVideoOutputs, collectHardwareSpec, formatGpu, formatSpecTable, normalizeBits, normalizeWindows, parseMemoryType, toGb } from './hardware-spec.mjs';

const selectedCimFixture = {
  computer:{Manufacturer:'Dell Inc.',Model:'Precision 3660 Tower'},
  operatingSystem:{Caption:'Microsoft Windows 11 Pro',Version:'10.0.26100',OSArchitecture:'64 ビット'},
  processor:{Name:'13th Gen Intel(R) Core(TM) i7-13700'},
  video:{Name:'NVIDIA RTX A2000',AdapterRAM:4293918720},
  memory:[
    {Capacity:17179869184,SMBIOSMemoryType:26,Speed:3200},
    {Capacity:17179869184,SMBIOSMemoryType:26,Speed:3200}
  ],
  memoryArrays:{MemoryDevices:4,MaxCapacityEx:134217728},
  disks:{Size:1024209543168,MediaType:4,BusType:17},
  cdrom:{Name:'HL-DT-ST DVD+-RW'},cdromKnown:true,
  networkAdapters:[
    {Name:'Intel(R) Ethernet Connection',Description:'Intel Gigabit Ethernet'},
    {Name:'Intel(R) Wi-Fi 6E AX211',Description:'Wireless Adapter'},
    {Name:'Bluetooth Device (Personal Area Network)',Description:'Bluetooth PAN'}
  ],
  videoOutputs:5
};

test('pure conversions classify expected hardware values', () => {
  assert.equal(parseMemoryType(26), 'DDR4'); assert.equal(parseMemoryType(34), 'DDR5'); assert.equal(parseMemoryType(999), '');
  assert.equal(toGb(16 * 1073741824), 16); assert.equal(classifyDisk({ mediaType: 4, busType: 17 }), 'NVMe');
  assert.equal(classifyDisk({ mediaType: 'SSD' }), 'SSD'); assert.equal(classifyDisk({ mediaType: 'HDD' }), 'HDD');
});

test('normalizes Windows architecture without preserving mojibake', () => {
  for (const value of ['64 ビット', '64 �r�b�g', '64-bit', 'x64', 'ARM64']) assert.equal(normalizeBits(value), '64bit');
  for (const value of ['32 ビット', '32-bit', 'x86', 'ARM32']) assert.equal(normalizeBits(value), '32bit');
  assert.equal(normalizeBits('unknown �'), '');
});

test('classifies physical Ethernet and Wi-Fi adapters but excludes Bluetooth PAN', () => {
  const result = classifyNetworkAdapters([
    { PhysicalAdapter:true, Name:'Intel(R) Ethernet Connection (2) I219-V' },
    { PhysicalAdapter:true, Description:'Realtek PCIe GbE Family Controller' },
    { PhysicalAdapter:true, Name:'Intel(R) Wi-Fi 6 AX201 160MHz' },
    { PhysicalAdapter:true, Name:'Bluetooth Device (Personal Area Network)' }
  ]);
  assert.deepEqual(result, { lan:'あり', wifi:'あり' });
  assert.deepEqual(classifyNetworkAdapters([{PhysicalAdapter:true,Name:'Bluetooth Device (Personal Area Network)'}]), {lan:'なし',wifi:'なし'});
});

test('classifies HDMI from WmiMonitorConnectionParams output technology', () => {
  assert.equal(classifyVideoOutputs([10, 5]), 'あり');
  // 接続中のモニタが DisplayPort だけでも HDMI 端子が無いとは言えない。
  // 実機(kim機)は DP 接続だが HDMI 端子はあり、ここを 'なし' にすると誤情報がシートに入る。
  assert.equal(classifyVideoOutputs([10]), '判定不能');
  assert.equal(classifyVideoOutputs([]), '判定不能');
});

test('formats GPU using registry VRAM and suppresses saturated AdapterRAM', () => {
  assert.equal(formatGpu({name:'NVIDIA GeForce GTX 1070 Ti',qwMemorySize:8589934592,adapterRam:4293918720}), 'NVIDIA GeForce GTX 1070 Ti 8GB');
  assert.equal(formatGpu({name:'NVIDIA GeForce GTX 1070 Ti',adapterRam:4294967295}), 'NVIDIA GeForce GTX 1070 Ti');
  assert.equal(formatGpu({name:'GPU',adapterRam:2147483648}), 'GPU 2GB');
});

test('normalizes the Select-Object CIM shape with two memory modules and no saturated VRAM', () => {
  const spec = normalizeWindows(selectedCimFixture, 'OFFICE-PC');
  assert.equal(spec.memoryGb,32); assert.equal(spec.memorySlotsFree,2);
  assert.equal(spec.gpu,'NVIDIA RTX A2000'); assert.equal(spec.bits,'64bit');
  assert.equal(spec.lan,'あり'); assert.equal(spec.wifi,'あり'); assert.equal(spec.hdmi,'あり');
  for (const key of ['maker','computerName','model','cpu','gpu','os','bits','memoryType','memoryGb','memorySlotsFree','memoryMaxGb','diskType','diskGb','opticalDrive','lan','wifi','hdmi']) {
    assert.notEqual(spec[key], '', `${key} must be populated`);
  }
});

test('normalizes a single PhysicalMemory object from ConvertTo-Json', () => {
  const fixture = { ...selectedCimFixture, memory:{Capacity:17179869184,SMBIOSMemoryType:34,Speed:5600} };
  const spec = normalizeWindows(fixture, 'ONE-DIMM');
  assert.equal(spec.memoryGb,16); assert.equal(spec.memoryType,'DDR5'); assert.equal(spec.memorySlotsFree,3);
});

test('Windows uses one injected PowerShell call and never reaches a real command', () => {
  let calls = 0;
  const raw = { computer:{Manufacturer:'Dell',Model:'X'},operatingSystem:{Caption:'Windows 11',Version:'10',OSArchitecture:'64 �r�b�g'},processor:{Name:'CPU'},video:{Name:'GPU',qwMemorySize:8589934592,AdapterRAM:4294967295},memory:[{Capacity:8589934592,SMBIOSMemoryType:26},{Capacity:8589934592,SMBIOSMemoryType:26}],memoryArrays:{MemoryDevices:4,MaxCapacityEx:33554432},disks:{MediaType:4,BusType:17,Size:1073741824000},cdrom:[],cdromKnown:true,networkAdapters:[{PhysicalAdapter:true,Name:'Intel(R) Ethernet Connection (2) I219-V'}],videoOutputs:[] };
  const spec = collectHardwareSpec({ platform:'win32', hostname:'PC-A', execFileSync(file,args,options) { calls++; assert.equal(file,'powershell.exe'); assert(args.join(' ').includes('Get-CimInstance')); assert(args.includes('Text')); assert(args.join(' ').includes('OutputEncoding')); assert(!args.join(' ').includes('wmic')); assert.equal(options.encoding,'utf8'); return JSON.stringify(raw); } });
  assert.equal(calls,1); assert.equal(spec.memoryGb,16); assert.equal(spec.memorySlotsFree,2); assert.equal(spec.diskType,'NVMe');
  assert.equal(spec.bits,'64bit'); assert.equal(spec.gpu,'GPU 8GB'); assert.equal(spec.lan,'あり'); assert.equal(spec.wifi,'なし');
  assert.equal(spec.opticalDrive,'なし'); assert.equal(spec.hdmi,'判定不能'); assert(spec._unresolved.includes('hdmi'));
});

test('command failure returns partial result and presence fields are tri-state', () => {
  let stderr='';
  const spec=collectHardwareSpec({platform:'win32',hostname:'safe-host',execFileSync(){throw new Error('no');},stderr:{write(value){stderr+=value;}}});
  assert.equal(spec.computerName,'safe-host'); for(const key of ['opticalDrive','lan','wifi','hdmi']) assert.equal(spec[key],'判定不能');
  assert.equal(spec._error,'no'); assert.match(stderr,/^hardware-spec: no\n$/);
  assert(formatSpecTable(spec).includes('safe-host')); const payload=buildSpecPayload({...spec,cpu:'',secret:'x'},'safe-host');
  assert.equal(payload.kind,'pc-spec'); assert(!Object.hasOwn(payload.spec,'secret')); assert(!Object.hasOwn(payload.spec,'cpu'));
});
