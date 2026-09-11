/**
 * One-tap starting points for the script creation flow.
 * They only pre-fill the form — the user still reviews every step.
 */
import type { ScriptParam } from "./params";

export interface ScriptTemplate {
  id: string;
  name: string;
  icon: string;
  description: string;
  command: string;
  cwd?: string;
  runMode: "manual" | "scheduled" | "both";
  onCalendar?: string;
  persistent?: boolean;
  params?: ScriptParam[];
}

export const SCRIPT_TEMPLATES: ScriptTemplate[] = [
  {
    id: "backup",
    name: "Backup",
    icon: "💾",
    description: "Archive an important folder (daily).",
    command: 'tar -czf "$HOME/backups/backup-$(date +%F).tar.gz" "$HOME/documents"',
    cwd: "$HOME",
    runMode: "both",
    onCalendar: "daily",
    persistent: true,
  },
  {
    id: "docker-updates",
    name: "Docker updates",
    icon: "🐳",
    description: "Pull fresh images and restart updated containers.",
    command: "docker images --format '{{.Repository}}:{{.Tag}}' | grep -v '<none>' | xargs -r -n1 docker pull",
    runMode: "both",
    onCalendar: "weekly",
    persistent: true,
  },
  {
    id: "cleanup",
    name: "Cleanup",
    icon: "🧹",
    description: "Clear caches, temp files and old logs.",
    command:
      "journalctl --vacuum-time=7d 2>/dev/null; docker system prune -f 2>/dev/null; rm -rf ~/.cache/* /tmp/* 2>/dev/null; df -h /",
    runMode: "both",
    onCalendar: "weekly",
    persistent: true,
  },
  {
    id: "restart-service",
    name: "Restart a service",
    icon: "🔄",
    description: "Restart a systemd service by name.",
    command: "sudo systemctl restart {{service}}",
    runMode: "manual",
    params: [
      { key: "service", type: "text", label: "Service", defaultValue: "jellyfin.service", required: true, placeholder: "name.service" },
    ],
  },
  {
    id: "room-lighting",
    name: "Room Lighting",
    icon: "💡",
    description: "Brightness, color and power for a smart light.",
    command: "curl -s 'http://nodemcu/cm?power={{power}}&brightness={{brightness}}&color={{color}}'",
    runMode: "both",
    params: [
      { key: "brightness", type: "slider", label: "Brightness", defaultValue: 75, min: 0, max: 100, step: 1, unit: "%", required: true },
      { key: "color", type: "color", label: "Color", defaultValue: "#ffffff", required: true },
      { key: "power", type: "toggle", label: "Power", defaultValue: true },
    ],
  },
];
