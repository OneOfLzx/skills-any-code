import cliProgress from 'cli-progress';
import inquirer from 'inquirer';
import pc from 'picocolors';

export class ProgressBar {
  private bar: cliProgress.SingleBar | null = null;
  private total: number = 0;
  private current: number = 0;

  start(total: number, initialValue: number = 0, payload?: any) {
    this.total = total;
    this.current = initialValue;
    
    this.bar = new cliProgress.SingleBar({
      format: `${pc.blue('解析进度')} |${pc.cyan('{bar}')}| {percentage}% | 已处理: {value}/{total} 对象 | 当前对象:\n{file}`,
      barCompleteChar: '\u2588',
      barIncompleteChar: '\u2591',
      hideCursor: true,
      clearOnComplete: false,
      // 非 TTY（如 CI/测试）时仍输出进度，便于断言；并将进度输出定向到 stdout，避免污染 stderr
      noTTYOutput: !process.stdout.isTTY,
      stream: process.stdout,
    }, cliProgress.Presets.shades_classic);

    this.bar.start(total, initialValue, { file: payload?.file || 'N/A' });
  }

  update(current: number, payload?: any) {
    this.current = current;
    this.bar?.update(current, { file: payload?.file || 'N/A' });
  }

  increment(step: number = 1, payload?: any) {
    this.current += step;
    this.bar?.increment(step, { file: payload?.file || 'N/A' });
  }

  stop() {
    this.bar?.stop();
    this.bar = null;
  }
}

export const progressBar = new ProgressBar();

export async function confirm(message: string, defaultAnswer: boolean = false): Promise<boolean> {
  const { answer } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'answer',
      message,
      default: defaultAnswer,
    },
  ]);
  return answer;
}

export async function select(message: string, choices: string[]): Promise<string> {
  const { selected } = await inquirer.prompt([
    {
      type: 'list',
      name: 'selected',
      message,
      choices,
    },
  ]);
  return selected;
}

export async function input(message: string, defaultValue?: string): Promise<string> {
  const { value } = await inquirer.prompt([
    {
      type: 'input',
      name: 'value',
      message,
      default: defaultValue,
    },
  ]);
  return value;
}
