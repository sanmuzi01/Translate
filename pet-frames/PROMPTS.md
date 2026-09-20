# 桌宠逐帧素材:出图提示词与使用步骤

## 怎么做

1. 用出图工具(做出 `pet.png` 的那个),每次**都附上参考图 `pet.png`**,按下面的提示词一个动作出一张"精灵表"。
2. 每张图保存到 `pet-frames/raw/`,文件名就是动作名:`walk.png`、`idle.png`、`sit.png` ……
3. 在项目根目录运行:`python tools/prepare_frames.py`
4. 打开 `pet-frames/preview/` 里的预览图,检查每个动作切得对不对(帧数、脚底是否落在红线上)。
5. 重启桌宠(`npm run tauri dev`)。有素材的动作会自动改用逐帧播放,没有素材的动作仍用旧的变形动画。

**建议顺序**:先做 `walk`、`idle`、`sit`、`sleep`、`hop` 这五个,效果最明显;其余的以后再补。
没有专门素材的动作会自动用相近的顶上(比如没有 `dance` 就用 `wave`)。

## 通用要求(每个提示词都要带上)

> Use the attached reference image as the exact character: same design, same proportions, same colors (blue body, pale yellow belly with dark stripes, tan tactical helmet with night-vision goggles and gray mask). Do not redesign it. Keep the same three-quarter view, the character always facing to the RIGHT.
> Output a single sprite sheet: the same character repeated in equal-sized cells on a perfectly flat, solid pure magenta background (#FF00FF). Every frame the same size and scale, the character centered in its cell with its feet on the same ground line in every cell, no overlap between cells and no part of the character touching a cell edge. No ground shadow, no floor, no text, no borders, no grid lines, no motion blur.

## 每个动作的提示词

把"通用要求"贴在最前面,再接下面这一段。

**walk(走路,8 帧,4 列 × 2 行)**
> A looping walk cycle in 8 frames, left to right, top row then bottom row. The chubby caterpillar-like body waddles: legs step alternately, body bobs up and down and sways slightly, tail swings, small arms swing opposite to the legs, helmet lags slightly behind the body. Frame 1 and frame 8 must lead smoothly back into frame 1.

**idle(待机,4 帧,4 列 × 1 行)**
> A subtle standing breathing loop in 4 frames: belly gently rises and falls, helmet tilts a tiny bit, hands slightly move. Very small differences between frames.

**sit(坐着,4 列 × 1 行)**
> The character sitting down on the ground, relaxed, body lowered and slightly wider. 4 frames of a gentle breathing loop, tiny differences.

**sleep(睡觉,4 列 × 1 行)**
> The character asleep while sitting, head with helmet drooping forward, 4 frames of slow deep breathing, tiny differences. Eyes/visor stay as in the reference; do not draw "Zzz" text.

**hop(原地跳,6 帧,3 列 × 2 行)**
> A single small jump in 6 frames: 1 crouch (body squashed), 2 push off (stretching up), 3 highest point in the air, 4 falling, 5 landing squash, 6 recovering to standing. Keep the same size across cells; the character may be higher in the cell only in frame 2-4.

**wave(挥手,6 帧,3 列 × 2 行)**
> The character standing and waving one small arm up and down in a friendly greeting, 6 frames looping.

**look(转头看,4 列 × 1 行)**
> The character standing and slowly turning its helmeted head to look around: 4 frames, head turns a little to one side then the other, body stays still, tiny differences.

**held(被提起,3 列 × 1 行)**
> The character being lifted by the top of the helmet, body and legs dangling and swinging helplessly, 3 frames.

**dance(跳舞,8 帧,4 列 × 2 行)**
> A cheerful looping dance in 8 frames: body swaying side to side, small arms up alternately, little bounces.

**happy(开心,4 列 × 1 行)**
> Very happy, bouncing with arms raised, 4 frames looping.

**surprise(受惊,3 列 × 1 行)**
> Startled: body jolts taller, arms up, leaning back slightly, 3 frames.

**stretch(伸懒腰,6 帧,3 列 × 2 行)**
> Stretching after waking up: arms slowly up, body stretching tall, then relaxing back to normal, 6 frames.

## 如果处理结果不对

- **帧数不对、多帧粘在一起**:在 `pet-frames/config.json` 里手动指定网格,例如 `{ "walk": { "grid": [4, 2] } }`。
- **生成的角色朝左**:配置 `{ "walk": { "facing": "left" } }`,会自动镜像成朝右。
- **某个动作里角色显得太大或太小**:配置 `{ "sit": { "scale": 0.9 } }`。
- **播放太快或太慢**:配置 `{ "walk": { "fps": 7 } }`。
- 改完配置后重新运行 `python tools/prepare_frames.py walk`(只重做指定的动作)。


## 现在还缺哪些动作(优先级)

内置桌宠目前已有:走路、待机、坐下、睡觉、挥手、开心、被提起、落地。
下面这些还是"拿别的图加程序动作顶替",画了专属帧会自然很多:

1. **hop(跳)** —— 桌宠最常做的动作之一,效果提升最明显。
2. **surprise(受惊)** —— 被点击时触发。
3. **stretch(伸懒腰)** —— 休息模式里会出现。
4. **look(转头)** —— 闲逛时偶尔出现。

## 生成之后怎么接进去

1. 出图保存为 `pet-frames/raw/<动作名>.png`(例如 `hop.png`)。
2. **保持角色大小一致**:提示词里加一句 "the character is exactly the same size as in the reference".
   如果生成的图里角色比其他动作大或小,在 `pet-frames/config.json` 里给这个动作单独设 `ref_h`(角色站立时的像素高度)。
3. 只处理新动作:`python tools/prepare_frames.py hop surprise stretch look`(不会影响已有动作)。
4. 看 `pet-frames/preview/` 里的预览,脚底应落在红线上。
5. 重新构建软件:`npm run tauri build`。
