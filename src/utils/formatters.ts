import { TranslationLog } from '../types';

export function formatTime(isoString: string): string {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('vi-VN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

export function formatDateGroup(isoString: string): string {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return 'Hôm nay';

  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfYesterday = new Date(startOfToday);
  startOfYesterday.setDate(startOfYesterday.getDate() - 1);
  const startOfTarget = new Date(date.getFullYear(), date.getMonth(), date.getDate());

  if (startOfTarget.getTime() === startOfToday.getTime()) {
    return 'Hôm nay';
  }
  if (startOfTarget.getTime() === startOfYesterday.getTime()) {
    return 'Hôm qua';
  }

  return date.toLocaleDateString('vi-VN', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

export function formatFullDateTime(isoString: string): string {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return '';
  return `${formatDateGroup(isoString)} · ${formatTime(isoString)}`;
}

export async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fallback below
  }

  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    textarea.style.left = '-9999px';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}

export function downloadLogsFile(logs: TranslationLog[], format: 'txt' | 'json'): void {
  const stamp = new Date().toISOString().slice(0, 10);
  let content = '';
  let mimeType = 'text/plain;charset=utf-8';
  let filename = `cydia-translate-log-${stamp}.txt`;

  if (format === 'json') {
    content = JSON.stringify(logs, null, 2);
    mimeType = 'application/json;charset=utf-8';
    filename = `cydia-translate-log-${stamp}.json`;
  } else {
    content = logs
      .map((entry) => {
        const dt = new Date(entry.createdAt).toLocaleString('vi-VN');
        const modeLabel = entry.mode === 'formal' ? 'Formal' : 'Chat';
        return `[${dt} | ${modeLabel}]\nIN : ${entry.input}\nOUT: ${entry.output}\n`;
      })
      .join('\n---\n\n');
  }

  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
