import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { PATHS, PROJECT_ROOT, TASK_NAME } from './constants.mjs';
import { atomicWriteJson } from './storage.mjs';

function runPowerShell(scriptPath, extraArgs = []) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...extraArgs], {
      cwd: PROJECT_ROOT,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ ok: true, stdout: stdout.trim(), stderr: stderr.trim() });
      else reject(Object.assign(new Error(stderr.trim() || stdout.trim() || `PowerShell exited ${code}`), { code: 'SCHEDULED_TASK_FAILURE', exitCode: code }));
    });
  });
}

export async function installScheduledTask() {
  if (process.platform !== 'win32') throw new Error('Scheduled Task installation is supported only on Windows');
  const result = await runPowerShell(path.join(PROJECT_ROOT, 'scripts', 'install-scheduled-task.ps1'), [
    '-TaskName', TASK_NAME,
    '-NodePath', process.execPath,
    '-CliPath', path.join(PROJECT_ROOT, 'src', 'cli.mjs'),
    '-WorkingDirectory', PROJECT_ROOT
  ]);
  const receipt = {
    installed: true,
    taskName: TASK_NAME,
    state: 'Ready',
    wakeToRun: false,
    startWhenAvailable: false,
    multipleInstancesPolicy: 'IgnoreNew',
    executionTimeLimit: 'PT20M',
    logonType: 'Interactive',
    runLevel: 'Limited',
    interval: 'PT5M',
    duration: 'PT5H30M',
    command: process.execPath,
    arguments: `"${path.join(PROJECT_ROOT, 'src', 'cli.mjs')}" tick`,
    workingDirectory: PROJECT_ROOT,
    installedAt: new Date().toISOString(),
    inspectionSource: 'verified-install-result'
  };
  await atomicWriteJson(PATHS.taskReceipt, receipt);
  return { ...result, receipt };
}

export async function removeScheduledTask() {
  if (process.platform !== 'win32') throw new Error('Scheduled Task removal is supported only on Windows');
  const result = await runPowerShell(path.join(PROJECT_ROOT, 'scripts', 'remove-scheduled-task.ps1'), ['-TaskName', TASK_NAME]);
  await fs.rm(PATHS.taskReceipt, { force: true });
  return result;
}

async function receiptFallback(error) {
  try {
    const receipt = JSON.parse(await fs.readFile(PATHS.taskReceipt, 'utf8'));
    return { supported: true, ...receipt, liveInspection: false, verificationError: error };
  } catch {
    return { installed: false, supported: true, error };
  }
}

export async function inspectScheduledTask() {
  if (process.platform !== 'win32') return { installed: false, supported: false };
  return new Promise((resolve) => {
    const script = `$ErrorActionPreference='Stop'; $task=Get-ScheduledTask -TaskName '${TASK_NAME.replaceAll("'", "''")}'; $trigger=$task.Triggers[0]; $action=$task.Actions[0]; [pscustomobject]@{installed=$true;taskName=$task.TaskName;state=$task.State.ToString();wakeToRun=[bool]$task.Settings.WakeToRun;startWhenAvailable=[bool]$task.Settings.StartWhenAvailable;multipleInstancesPolicy=$task.Settings.MultipleInstances.ToString();executionTimeLimit=$task.Settings.ExecutionTimeLimit.ToString();logonType=$task.Principal.LogonType.ToString();runLevel=$task.Principal.RunLevel.ToString();interval=$trigger.Repetition.Interval.ToString();duration=$trigger.Repetition.Duration.ToString();command=$action.Execute;arguments=$action.Arguments;workingDirectory=$action.WorkingDirectory} | ConvertTo-Json -Compress`;
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', async (error) => resolve(await receiptFallback(error.message)));
    child.on('close', async (code) => {
      if (code !== 0) return resolve(await receiptFallback(stderr.trim() || stdout.trim() || 'Task not found'));
      try { resolve({ supported: true, ...JSON.parse(stdout), liveInspection: true, inspectionSource: 'windows-task-scheduler' }); }
      catch (error) { resolve(await receiptFallback(`Unable to parse task inspection: ${error.message}`)); }
    });
  });
}
