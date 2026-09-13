/**
 * Unit tests for the ops command risk classification. The levels feed the
 * `tools/pre-execute` gate; the gate's enforcement behavior is covered by the
 * real Loader composition in `approval.spec.ts`.
 */

import { describe, expect, it } from 'vitest'
import { classifyCommandRisk } from '../src/risk.ts'
import type { Environment, RiskLevel } from '@deepseek-ai/dsh-ops-common'

function level(command: string, environment: Environment = 'lab'): RiskLevel {
  return classifyCommandRisk(command, environment)
}

describe('classifyCommandRisk read-only commands', () => {
  it('classifies fixed read primitives as L0', () => {
    expect(level('cat /etc/hostname')).toBe('L0')
    expect(level('df -hP')).toBe('L0')
    expect(level('free -m')).toBe('L0')
    expect(level('uptime')).toBe('L0')
    expect(level('ls -la /var/log')).toBe('L0')
    expect(level('ps aux')).toBe('L0')
    expect(level('echo hello')).toBe('L0')
    expect(level('tail -n 20 /var/log/nginx/error.log')).toBe('L0')
    expect(level('head -n 2 /etc/os-release')).toBe('L0')
    expect(level('grep -r upstream /etc/nginx')).toBe('L0')
  })

  it('classifies pipelines and chained reads as L0', () => {
    expect(level('ls -la /var/log | grep nginx')).toBe('L0')
    expect(level('cd /var/log && tail -n 20 error.log')).toBe('L0')
    expect(level('cat /etc/os-release | head -n 2')).toBe('L0')
  })

  it('classifies compound verbs only with a read subcommand as L0', () => {
    expect(level('systemctl status nginx')).toBe('L0')
    expect(level('systemctl is-active nginx')).toBe('L0')
    expect(level('service nginx status')).toBe('L0')
    expect(level('git status')).toBe('L0')
    expect(level('docker ps')).toBe('L0')
    expect(level('docker logs web-01')).toBe('L0')
    expect(level('kubectl get pods')).toBe('L0')
    expect(level('nginx -t')).toBe('L0')
  })

  it('classifies read-only in every environment as L0', () => {
    for (const environment of ['dev', 'staging', 'prod', 'lab'] as const) {
      expect(level('cat /etc/hostname', environment)).toBe('L0')
    }
  })

  it('keeps file-path arguments that look like tool names read-only', () => {
    expect(level('ls /var/lib/docker')).toBe('L0')
    expect(level('grep docker /etc/hosts')).toBe('L0')
    expect(level('find / -name *.log')).toBe('L0')
    expect(level('ps aux | grep python')).toBe('L0')
  })
})

describe('classifyCommandRisk mutating commands', () => {
  it('classifies a mutation as L1 in dev and lab, escalating by environment', () => {
    expect(level('touch /tmp/marker')).toBe('L1')
    expect(level('touch /tmp/marker', 'dev')).toBe('L1')
    expect(level('touch /tmp/marker', 'staging')).toBe('L2')
    expect(level('touch /tmp/marker', 'prod')).toBe('L3')
  })

  it('classifies compound verbs with a mutating subcommand', () => {
    expect(level('systemctl restart nginx')).toBe('L1')
    expect(level('systemctl restart nginx', 'prod')).toBe('L3')
    expect(level('service nginx restart')).toBe('L1')
    expect(level('git push origin main')).toBe('L1')
    expect(level('docker stop web-01')).toBe('L1')
    expect(level('kubectl delete pod web')).toBe('L1')
  })

  it('classifies scoped file and package mutations', () => {
    expect(level('rm /tmp/old')).toBe('L1')
    expect(level('mv /tmp/a /tmp/b')).toBe('L1')
    expect(level('chmod 600 /etc/nginx/nginx.conf')).toBe('L1')
    expect(level('apt install nginx')).toBe('L1')
    expect(level('mkdir -p /var/www')).toBe('L1')
  })

  it('classifies redirection and sequencing as mutating', () => {
    expect(level('echo x > /tmp/out')).toBe('L1')
    expect(level('echo x >> /var/log/out')).toBe('L1')
    expect(level('echo x && git push origin main')).toBe('L1')
    expect(level('echo $(rm -f /tmp/x)')).toBe('L1')
    expect(level('echo `touch /tmp/x`')).toBe('L1')
    expect(level('echo $((1 + 1))')).toBe('L0')
  })

  it('classifies privileged and arbitrary-code invocations as mutating', () => {
    expect(level('sudo systemctl status nginx')).toBe('L1')
    expect(level('python -c "print(1)"')).toBe('L1')
    expect(level('bash /tmp/script.sh')).toBe('L1')
    expect(level('curl -s http://localhost:8080/health')).toBe('L1')
  })

  it('classifies a bare compound verb and blank commands as mutating', () => {
    expect(level('systemctl')).toBe('L1')
    expect(level('')).toBe('L1')
    expect(level('   ')).toBe('L1')
  })

  it('classifies find with a deleting flag as mutating', () => {
    expect(level('find / -delete')).toBe('L1')
    expect(level('find / -exec rm {} ;')).toBe('L1')
  })
})

describe('classifyCommandRisk destructive commands', () => {
  it('classifies root-targeted rm as L4', () => {
    expect(level('rm -rf /')).toBe('L4')
    expect(level('rm -rf /*')).toBe('L4')
    expect(level('rm -r /')).toBe('L4')
  })

  it('keeps a scoped rm destructive only at the root', () => {
    expect(level('rm -rf /tmp')).toBe('L1')
    expect(level('rm /tmp/old')).toBe('L1')
  })

  it('classifies device and filesystem destructive patterns as L4', () => {
    expect(level('mkfs.ext4 /dev/sdb1')).toBe('L4')
    expect(level('fdisk /dev/sda')).toBe('L4')
    expect(level('parted /dev/sda mklabel gpt')).toBe('L4')
    expect(level('dd if=/dev/zero of=/dev/sda')).toBe('L4')
  })

  it('classifies host and process destructive patterns as L4', () => {
    expect(level('reboot')).toBe('L4')
    expect(level('shutdown -h now')).toBe('L4')
    expect(level('kill -9 1')).toBe('L4')
  })

  it('classifies data-destroying patterns as L4', () => {
    expect(level('mysql -e "drop database prod"')).toBe('L4')
    expect(level('crontab -r')).toBe('L4')
    expect(level('git push --force origin main')).toBe('L4')
  })

  it('stays L4 in every environment', () => {
    for (const environment of ['dev', 'staging', 'prod', 'lab'] as const) {
      expect(level('rm -rf /', environment)).toBe('L4')
    }
  })
})
