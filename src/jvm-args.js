// Добавление пользовательских JVM аргументов
function addUserJVMArgs(jvmArgs) {
    // 1. Сначала добавляем флаги из нового модального окна
    const savedFlags = localStorage.getItem('jvm-selected-flags');
    if (savedFlags) {
        try {
            const flags = JSON.parse(savedFlags);
            const flagMap = {
                'g1gc': '-XX:+UseG1GC',
                'parallel-gc': '-XX:+UseParallelGC',
                'serial-gc': '-XX:+UseSerialGC',
                'zgc': '-XX:+UseZGC',
                'string-dedup': '-XX:+UseStringDeduplication',
                'tiered': '-XX:+TieredCompilation',
                'large-pages': '-XX:+UseLargePages',
                'disable-explicit-gc': '-XX:-DisableExplicitGC',
                'compile-threshold': '-XX:CompileThreshold=1000',
                'inline': '-XX:+AggressiveOpts'
            };

            flags.forEach(flagId => {
                if (flagMap[flagId]) {
                    const flag = flagMap[flagId];
                    // Проверяем, нет ли уже такого флага
                    const alreadyExists = jvmArgs.some(arg => arg.includes(flag.split('=')[0]));
                    if (!alreadyExists) {
                        // Вставляем перед mainClass
                        const insertIndex = jvmArgs.findIndex(a => a.includes('net.minecraft') || a === 'mainClass');
                        if (insertIndex > 0) {
                            jvmArgs.splice(insertIndex, 0, flag);
                            console.log('Added JVM flag:', flag);
                        }
                    }
                }
            });
        } catch (e) {
            console.error('Error parsing saved JVM flags:', e);
        }
    }

    // 2. Затем добавляем аргументы из старого поля (для совместимости)
    const customArgs = (localStorage.getItem('minecraft-args') || '').trim();
    if (!customArgs) return jvmArgs;

    console.log('Using custom JVM args:', customArgs);

    // Разбиваем аргументы, сохраняя кавычки
    const argsArray = customArgs.match(/(?:[^\s"]+|"[^"]*")+/g) || [];

    argsArray.forEach(arg => {
        const cleanArg = arg.replace(/^"|"$/g, '');
        // Пропускаем аргументы которые уже есть
        if (cleanArg && !cleanArg.startsWith('-Xmx') && !cleanArg.startsWith('-Xms')) {
            // Вставляем перед mainClass (обычно это 'net.minecraft.client.Main')
            const insertIndex = jvmArgs.findIndex(a => a.includes('net.minecraft') || a === 'mainClass');
            if (insertIndex > 0) {
                jvmArgs.splice(insertIndex, 0, cleanArg);
            }
        }
    });

    return jvmArgs;
}

module.exports = { addUserJVMArgs };
