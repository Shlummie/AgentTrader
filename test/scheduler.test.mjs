import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const script = await fs.readFile(new URL('../scripts/install-scheduled-task.ps1', import.meta.url), 'utf8');

test('Scheduled Task definition is weekday, bounded, current-user, and cannot wake or catch up', () => {
  assert.match(script, /<Interval>PT5M<\/Interval>/);
  assert.match(script, /<Duration>PT5H30M<\/Duration>/);
  assert.match(script, /<Monday \/><Tuesday \/><Wednesday \/><Thursday \/><Friday \/>/);
  assert.match(script, /<LogonType>InteractiveToken<\/LogonType>/);
  assert.match(script, /<RunLevel>LeastPrivilege<\/RunLevel>/);
  assert.match(script, /<WakeToRun>false<\/WakeToRun>/);
  assert.match(script, /<StartWhenAvailable>false<\/StartWhenAvailable>/);
  assert.match(script, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/);
  assert.match(script, /<ExecutionTimeLimit>PT20M<\/ExecutionTimeLimit>/);
});
