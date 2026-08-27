#!/usr/bin/env node
import osModule from 'node:os';
import fsModule from 'node:fs';
import { execFileSync as nodeExecFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PRESENCE = new Set(['あり', 'なし', '判定不能']);
const FIELDS = ['maker','computerName','model','cpu','gpu','os','bits','memoryType','memoryGb','memorySlotsFree','memoryMaxGb','diskType','diskGb','opticalDrive','lan','wifi','hdmi'];

export function parseMemoryType(code) {
  const n = Number(code);
  return ({ 24: 'DDR3', 26: 'DDR4', 34: 'DDR5' })[n] || '';
}
export function toGb(bytes) {
  const n = Number(bytes);
  return Number.isFinite(n) && n >= 0 ? Math.round(n / 1073741824 * 10) / 10 : '';
}
export function classifyDisk({ mediaType, busType } = {}) {
  const media = String(mediaType ?? '').toLowerCase();
  const bus = String(busType ?? '').toLowerCase();
  if (bus.includes('nvme') || bus === '17') return 'NVMe';
  if (media.includes('ssd') || media === '4') return 'SSD';
  if (media.includes('hdd') || media.includes('hard disk') || media === '3') return 'HDD';
  return '';
}
export function normalizeBits(raw) {
  const value = String(raw ?? '').trim().toLowerCase();
  if (/arm64|aarch64|x64|amd64|\b64(?:\s*[-]?\s*bit)?\b/.test(value)) return '64bit';
  if (/arm32|aarch32|x86|i[3-6]86|\b32(?:\s*[-]?\s*bit)?\b/.test(value)) return '32bit';
  return '';
}
export function classifyNetworkAdapters(adapters) {
  const physical = asArray(adapters).filter(adapter => adapter?.PhysicalAdapter !== false);
  if (!physical.length) return { lan: '判定不能', wifi: '判定不能' };
  let lan = false; let wifi = false;
  for (const adapter of physical) {
    const value = `${text(adapter?.Name)} ${text(adapter?.Description)}`;
    if (/bluetooth/i.test(value)) continue;
    if (/wi[ -]?fi|wireless|802\.11|wlan/i.test(value)) wifi = true;
    if (/ethernet|\bgbe\b|gigabit|realtek\s+pcie|intel\(r\)\s+ethernet/i.test(value)) lan = true;
  }
  return { lan: lan ? 'あり' : 'なし', wifi: wifi ? 'あり' : 'なし' };
}
// WmiMonitorConnectionParams は「今つながっているモニタの接続方式」しか返さないので、
// HDMI(5) が含まれれば端子ありと断定できるが、含まれないことは「端子が無い」証拠にならない
// (実機で DisplayPort 接続のため HDMI 端子があるのに『なし』と出た)。断定できない側は判定不能にする。
export function classifyVideoOutputs(codes) {
  const values = asArray(codes).map(Number).filter(Number.isFinite);
  if (!values.length) return '判定不能';
  return values.includes(5) ? 'あり' : '判定不能';
}
export function formatGpu({ name, qwMemorySize, adapterRam } = {}) {
  const gpuName = text(name);
  let bytes = Number(qwMemorySize);
  if (!(Number.isFinite(bytes) && bytes > 0)) {
    bytes = Number(adapterRam);
    // Win32_VideoController.AdapterRAM saturates close to 4 GiB.
    if (Number.isFinite(bytes) && bytes >= 4278190080 && bytes <= 4294967296) bytes = NaN;
  }
  return [gpuName, Number.isFinite(bytes) && bytes > 0 ? `${toGb(bytes)}GB` : ''].filter(Boolean).join(' ');
}
function classifyCimDisk(value) { return classifyDisk({ mediaType: value?.MediaType ?? value?.mediaType, busType: value?.BusType ?? value?.busType }); }
function text(value) { return value == null ? '' : String(value).trim(); }
function presence(value) { return PRESENCE.has(value) ? value : '判定不能'; }
function sum(values, mapper = Number) {
  const nums = (Array.isArray(values) ? values : []).map(mapper).filter(Number.isFinite);
  return nums.length ? nums.reduce((a, b) => a + b, 0) : '';
}
function asArray(value) { return value == null ? [] : Array.isArray(value) ? value : [value]; }

export function normalizeWindows(raw, hostname = '') {
  raw = raw && typeof raw === 'object' ? raw : {};
  const memory = asArray(raw.memory); const arrays = asArray(raw.memoryArrays); const disks = asArray(raw.disks);
  const gpu = asArray(raw.video).map(v => formatGpu({ name: v.Name, qwMemorySize: v.qwMemorySize, adapterRam: v.AdapterRAM })).filter(Boolean).join(', ');
  const network = classifyNetworkAdapters(raw.networkAdapters);
  const maxKb = sum(arrays, a => Number(a.MaxCapacityEx));
  const totalBytes = sum(memory, m => Number(m.Capacity));
  return {
    maker: text(raw.computer?.Manufacturer), computerName: hostname, model: text(raw.computer?.Model),
    cpu: asArray(raw.processor).map(v => text(v.Name)).filter(Boolean).join(', '), gpu,
    os: [text(raw.operatingSystem?.Caption), text(raw.operatingSystem?.Version)].filter(Boolean).join(' '), bits: normalizeBits(raw.operatingSystem?.OSArchitecture),
    memoryType: [...new Set(memory.map(v => parseMemoryType(v.SMBIOSMemoryType)).filter(Boolean))].join('/'), memoryGb: totalBytes === '' ? '' : toGb(totalBytes),
    memorySlotsFree: arrays.length && memory.length ? Math.max(0, sum(arrays, a => Number(a.MemoryDevices)) - memory.length) : '', memoryMaxGb: maxKb === '' ? '' : toGb(maxKb * 1024),
    diskType: [...new Set(disks.map(classifyCimDisk).filter(Boolean))].join('/'), diskGb: (() => { const n = sum(disks, d => Number(d.Size ?? d.size)); return n === '' ? '' : toGb(n); })(),
    opticalDrive: raw.cdromKnown ? (asArray(raw.cdrom).length ? 'あり' : 'なし') : '判定不能',
    lan: network.lan, wifi: network.wifi, hdmi: classifyVideoOutputs(raw.videoOutputs), deviceType: text(raw.deviceType)
  };
}

const WINDOWS_SCRIPT = `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $OutputEncoding=[System.Text.Encoding]::UTF8; $ErrorActionPreference='SilentlyContinue'
$cs=Get-CimInstance Win32_ComputerSystem|Select-Object -Property Manufacturer,Model
$os=Get-CimInstance Win32_OperatingSystem|Select-Object -Property Caption,Version,OSArchitecture
$mem=@(Get-CimInstance Win32_PhysicalMemory|Select-Object -Property Capacity,SMBIOSMemoryType,Speed)
$ma=@(Get-CimInstance Win32_PhysicalMemoryArray|Select-Object -Property MemoryDevices,MaxCapacityEx)
$net=@(Get-CimInstance Win32_NetworkAdapter|Where-Object {$_.PhysicalAdapter -eq $true}|Select-Object -Property Name,Description)
$gpuReg=@(Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}\\0*')
$video=@(Get-CimInstance Win32_VideoController|Select-Object -Property Name,AdapterRAM|ForEach-Object {$v=$_;$r=$gpuReg|Where-Object {$_.DriverDesc -eq $v.Name}|Select-Object -First 1;[ordered]@{Name=$v.Name;AdapterRAM=$v.AdapterRAM;qwMemorySize=$r.'HardwareInformation.qwMemorySize'}})
$outputs=@();try{$outputs=@(Get-CimInstance -Namespace root/wmi -ClassName WmiMonitorConnectionParams|Select-Object -Property VideoOutputTechnology|ForEach-Object {$_.VideoOutputTechnology})}catch{}
$processor=@(Get-CimInstance Win32_Processor|Select-Object -Property Name)
$disks=@(Get-CimInstance -Namespace root/Microsoft/Windows/Storage MSFT_PhysicalDisk|Select-Object -Property Size,MediaType,BusType)
$cdrom=@(Get-CimInstance Win32_CDROMDrive|Select-Object -Property Name);$cdromKnown=$?
$result=[ordered]@{computer=$cs;operatingSystem=$os;processor=$processor;video=$video;memory=$mem;memoryArrays=$ma;disks=$disks;cdrom=$cdrom;cdromKnown=$cdromKnown;networkAdapters=$net;videoOutputs=$outputs}
$result|ConvertTo-Json -Depth 4 -Compress`;

export function collectHardwareSpec({ platform = process.platform, hostname = osModule.hostname(), execFileSync = nodeExecFileSync, fs = fsModule, stderr = process.stderr } = {}) {
  let spec = { computerName: hostname };
  try {
    if (platform === 'win32') {
      const raw = JSON.parse(execFileSync('powershell.exe', ['-NoProfile','-NonInteractive','-OutputFormat','Text','-Command', WINDOWS_SCRIPT], { encoding: 'utf8', windowsHide: true }));
      spec = normalizeWindows(raw, hostname);
    } else if (platform === 'darwin') {
      const run = (...args) => text(execFileSync(args[0], args.slice(1), { encoding: 'utf8' }));
      const hw = run('system_profiler', 'SPHardwareDataType', 'SPMemoryDataType');
      spec = { computerName: hostname, maker: 'Apple', model: hw.match(/Model Identifier:\s*(.+)/)?.[1] || '', cpu: run('sysctl','-n','machdep.cpu.brand_string'), os: run('sw_vers','-productName') + ' ' + run('sw_vers','-productVersion'), bits: run('uname','-m'), memoryGb: toGb(Number(hw.match(/Memory:\s*([\d.]+) GB/)?.[1]) * 1073741824), opticalDrive:'判定不能',lan:'判定不能',wifi:'判定不能',hdmi:'判定不能' };
    } else {
      const run = (...args) => text(execFileSync(args[0], args.slice(1), { encoding: 'utf8' }));
      let cpuInfo = ''; let release = ''; try { cpuInfo = fs.readFileSync('/proc/cpuinfo','utf8'); } catch {} try { release = fs.readFileSync('/etc/os-release','utf8'); } catch {}
      spec = { computerName: hostname, cpu: cpuInfo.match(/^model name\s*:\s*(.+)$/m)?.[1] || '', os: release.match(/^PRETTY_NAME=["']?(.+?)["']?$/m)?.[1] || '', bits: run('uname','-m'), opticalDrive:'判定不能',lan:'判定不能',wifi:'判定不能',hdmi:'判定不能' };
    }
  } catch (error) {
    spec._error = error instanceof Error ? error.message : String(error);
    stderr.write(`hardware-spec: ${spec._error.replace(/[\r\n]+/g, ' ')}\n`);
  }
  for (const key of ['opticalDrive','lan','wifi','hdmi']) spec[key] = presence(spec[key]);
  spec._unresolved = FIELDS.filter(key => spec[key] === '' || spec[key] == null || (['opticalDrive','lan','wifi','hdmi'].includes(key) && spec[key] === '判定不能'));
  return spec;
}

export function formatSpecTable(spec) {
  const labels = { maker:'メーカー',computerName:'コンピュータ名',model:'型番',cpu:'CPU',gpu:'GPU/VRAM',os:'OS',bits:'ビット数',memoryType:'メモリ種類',memoryGb:'メモリ容量(GB)',memorySlotsFree:'空きスロット',memoryMaxGb:'メモリ最大容量',diskType:'ストレージ種類',diskGb:'ストレージ容量(GB)',opticalDrive:'光学ドライブ',lan:'有線LAN',wifi:'無線LAN',hdmi:'HDMI' };
  const width = Math.max(...Object.values(labels).map(v => v.length));
  return Object.entries(labels).map(([key, label]) => `${label.padEnd(width)} | ${spec[key] === '' || spec[key] == null ? '未取得' : spec[key]}`).join('\n');
}
export function buildSpecPayload(spec, hostname = spec?.computerName || '') {
  const clean = {};
  for (const key of [...FIELDS, 'deviceType']) if (spec?.[key] !== '' && spec?.[key] != null) clean[key] = spec[key];
  return { kind: 'pc-spec', hostname: text(hostname), spec: clean };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const spec = collectHardwareSpec();
  console.log(process.argv.includes('--json') ? JSON.stringify(spec, null, 2) : formatSpecTable(spec));
  const hardwareFields = FIELDS.filter(key => key !== 'computerName');
  if (hardwareFields.every(key => spec._unresolved.includes(key))) process.exitCode = 1;
}
