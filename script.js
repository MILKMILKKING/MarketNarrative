        // --- 全局状态管理 ---
        let myChart;
        let currentPeriod = '1d';
        let currentTicker = 'ONC'; // 百济神州
        let currentAnnotations = [];
        let annotationHistory = [];
        let historyIndex = -1;
        let currentChartData = null; // V2.2: 全局保存图表数据
        
        // 侧边栏状态管理
        let sidebarState = {
            isOpen: false
        };
        
        // V4.8.2: 注释排序状态管理
        let annotationSortOrder = 'desc'; // 'asc' | 'desc' 默认降序（最新在前）
        
        // V4.8.3: 批量分析状态管理 - 简化版本
        let batchAnalysisState = {
            selectedAnnotations: new Set(),    // 选中的注释ID集合
            processingQueue: [],              // 待处理的注释队列
            currentBatch: [],                 // 当前正在处理的批次
            isProcessing: false,              // 是否正在处理中
            processedCount: 0,                // 已处理数量
            totalCount: 0,                    // 总数量
            maxConcurrent: 10,                // 最大并发数（恢复到10，之前这个数量工作正常）
            isCancelled: false,               // 是否被取消
            failedTasks: new Set(),           // 失败的任务ID集合
            monitoringInterval: null          // 状态监控定时器ID
        };
        
        // V5.2: 鼠标位置跟踪（用于智能缩放）
        let lastMousePosition = {
            x: null,
            y: null,
            dataIndex: null,
            isValid: false
        };

        // V5.8: AI模式管理
        let currentAIMode = 'pro';  // 默认pro模式

        // V5.8.4: 时间筛选状态管理
        let timeFilterState = {
            enabled: true,            // 默认启用筛选（显示最近10年）
            mode: '10y',              // 默认模式：最近10年
            startDate: null,          // 自定义开始日期
            endDate: null             // 自定义结束日期
        };

        // --- DOM 元素缓存 ---
        let dom = {};

        // --- 通知系统 ---
        function showNotification(message, type = 'info', duration = 3000) {
            const notification = document.getElementById('notification');
            if (!notification) {
                console.warn('通知容器未找到');
                return;
            }
            
            // 清除之前的类名和定时器
            notification.className = 'notification';
            if (notification.hideTimer) {
                clearTimeout(notification.hideTimer);
            }
            
            // 设置消息和类型
            notification.textContent = message;
            notification.classList.add(type, 'show');
            
            // 设置自动隐藏
            notification.hideTimer = setTimeout(() => {
                notification.classList.remove('show');
                // 动画完成后清理
                setTimeout(() => {
                    notification.className = 'notification';
                    notification.textContent = '';
                }, 300);
            }, duration);
        }

        // --- 样式设置 ---
        let styleSettings = {
            bgColor: '#f0e68c',
            textColor: '#000000',
            fontSize: 13,
            lineColor: '#000000',
            opacity: 0.8,
            timeSpanThreshold: 1,
            contentThreshold: 30,  // 注释内容完善阈值，默认30字符
            zoomStep: 10  // V5.2: 键盘缩放比例，默认10%
        };

        // --- 持久化管理系统 ---
        const ANNOTATION_POSITIONS_KEY = 'stockAnalysis_annotationPositions';
        const STYLE_SETTINGS_KEY = 'stockAnalysis_styleSettings';

        // 生成注释的唯一标识符
        function generateAnnotationKey(ticker, date, text) {
            // 清理文本，移除特殊字符和空格，限制长度以避免键过长
            const cleanText = text.replace(/[^\w\u4e00-\u9fa5]/g, '').substring(0, 50);
            return `${ticker}-${date}-${cleanText}`;
        }

        // 从localStorage加载注释位置数据
        function loadAnnotationPositions() {
            try {
                const saved = localStorage.getItem(ANNOTATION_POSITIONS_KEY);
                return saved ? JSON.parse(saved) : {};
            } catch (error) {
                console.warn('加载注释位置数据失败:', error);
                return {};
            }
        }

        // 保存注释位置数据到localStorage
        function saveAnnotationPositions(positions) {
            try {
                localStorage.setItem(ANNOTATION_POSITIONS_KEY, JSON.stringify(positions));
            } catch (error) {
                console.warn('保存注释位置数据失败:', error);
            }
        }

        // 获取特定注释的保存位置
        function getSavedAnnotationPosition(ticker, date, text) {
            const positions = loadAnnotationPositions();
            const key = generateAnnotationKey(ticker, date, text);
            return positions[key] || null;
        }

        // 保存特定注释的位置（支持股价坐标系、相对偏移和绝对位置）
        function saveAnnotationPosition(ticker, date, text, position, klineData = null) {
            const positions = loadAnnotationPositions();
            const key = generateAnnotationKey(ticker, date, text);
            
            // 新的股价坐标系数据结构
            const positionData = {
                width: position.width,
                height: position.height,
                savedAt: Date.now()
            };
            
            // 如果提供了K线数据，计算基于股价的偏移（新方式）
            if (klineData && klineData.pixel && klineData.price && klineData.dateIndex !== undefined) {
                const boxLeft = parseInt(position.left);
                const boxTop = parseInt(position.top);
                const boxWidth = parseInt(position.width);
                const boxHeight = parseInt(position.height);
                
                // 计算注释框中心的像素位置
                const boxCenterX = boxLeft + boxWidth / 2;
                const boxCenterY = boxTop + boxHeight / 2;
                
                // 将注释框中心的像素位置转换为股价坐标
                const annotationPrice = myChart.convertFromPixel({ gridIndex: 0 }, [boxCenterX, boxCenterY]);
                
                if (annotationPrice && annotationPrice.length >= 2) {
                    // 计算相对于K线的偏移（以股价和时间索引为单位）
                    positionData.priceOffset = annotationPrice[1] - klineData.price; // 股价偏移
                    positionData.timeOffset = annotationPrice[0] - klineData.dateIndex; // 时间偏移（索引）
                    positionData.positionType = 'price_based'; // 标记为股价定位
                    
                    console.log(`已保存股价偏移: ${key}`, {
                        priceOffset: positionData.priceOffset.toFixed(2),
                        timeOffset: positionData.timeOffset.toFixed(2),
                        basePrice: klineData.price,
                        baseDateIndex: klineData.dateIndex
                    });
                } else {
                    // 转换失败，回退到像素偏移
                    positionData.offsetX = boxCenterX - klineData.pixel.x;
                    positionData.offsetY = boxCenterY - klineData.pixel.y;
                    positionData.positionType = 'relative';
                    
                    console.log(`股价转换失败，使用像素偏移: ${key}`);
                }
            } else if (klineData && klineData.pixel) {
                // 向后兼容：使用像素偏移（中等方式）
                const boxLeft = parseInt(position.left);
                const boxTop = parseInt(position.top);
                const boxWidth = parseInt(position.width);
                const boxHeight = parseInt(position.height);
                
                const boxCenterX = boxLeft + boxWidth / 2;
                const boxCenterY = boxTop + boxHeight / 2;
                
                positionData.offsetX = boxCenterX - klineData.pixel.x;
                positionData.offsetY = boxCenterY - klineData.pixel.y;
                positionData.positionType = 'relative';
                
                console.log(`已保存像素偏移: ${key}`);
            } else {
                // 向后兼容：保存绝对位置（旧方式）
                positionData.left = position.left;
                positionData.top = position.top;
                positionData.positionType = 'absolute';
                
                console.log(`已保存绝对位置: ${key}`);
            }
            
            positions[key] = positionData;
            saveAnnotationPositions(positions);
        }

        // 清理过期的位置数据（可选，防止localStorage过大）
        function cleanupOldPositions(daysToKeep = 90) {
            const positions = loadAnnotationPositions();
            const cutoffTime = Date.now() - (daysToKeep * 24 * 60 * 60 * 1000);
            let cleaned = false;

            for (const key in positions) {
                if (positions[key].savedAt && positions[key].savedAt < cutoffTime) {
                    delete positions[key];
                    cleaned = true;
                }
            }

            if (cleaned) {
                saveAnnotationPositions(positions);
                console.log('已清理过期的注释位置数据');
            }
        }

        // V5.2: 样式设置持久化管理
        function loadStyleSettings() {
            try {
                const saved = localStorage.getItem(STYLE_SETTINGS_KEY);
                if (saved) {
                    const parsed = JSON.parse(saved);
                    // 合并设置，确保新增的设置项有默认值
                    Object.assign(styleSettings, parsed);
                }
            } catch (error) {
                console.warn('加载样式设置失败:', error);
            }
        }

        function saveStyleSettings() {
            try {
                localStorage.setItem(STYLE_SETTINGS_KEY, JSON.stringify(styleSettings));
            } catch (error) {
                console.warn('保存样式设置失败:', error);
            }
        }

        // V5.8: AI模式管理函数
        function getCurrentAIMode() {
            const selected = document.querySelector('input[name="ai-mode"]:checked');
            return selected ? selected.value : 'pro';
        }

        function resetAIModeOnLoad() {
            // 页面加载时重置为pro模式
            const proModeRadio = document.getElementById('ai-mode-pro');
            if (proModeRadio) {
                proModeRadio.checked = true;
                currentAIMode = 'pro';
            }
        }

        function getConcurrentLimit(aiMode) {
            // 根据AI模式获取并发数限制
            const limits = {
                'flash': 150,  // 极速模式
                'pro': 10,     // 平衡模式
                'ultra': 60    // 深度模式
            };
            return limits[aiMode] || 10;
        }

        function updateConcurrentLimitBasedOnAIMode() {
            // 更新批量分析的并发数限制
            const currentMode = getCurrentAIMode();
            batchAnalysisState.maxConcurrent = getConcurrentLimit(currentMode);

            console.log(`[AI模式] 当前模式: ${currentMode}, 并发数: ${batchAnalysisState.maxConcurrent}`);
        }

        function setupAIModeListeners() {
            // 设置AI模式选择器的事件监听
            const aiModeRadios = document.querySelectorAll('input[name="ai-mode"]');
            aiModeRadios.forEach(radio => {
                radio.addEventListener('change', function() {
                    if (this.checked) {
                        currentAIMode = this.value;
                        updateConcurrentLimitBasedOnAIMode();
                        showNotification(`🤖 已切换到 ${this.value.toUpperCase()} 模式`, 'info', 2000);
                    }
                });
            });
        }

        // --- 初始化函数 ---
        function init() {
            // 启动时清理过期的位置数据
            cleanupOldPositions();

            // V5.2: 加载样式设置
            loadStyleSettings();

            // V5.8: 初始化AI模式
            resetAIModeOnLoad();
            
            // 缓存所有需要操作的DOM元素
            dom = {
                chartContainer: document.getElementById('chart-container'),
                infoBoxContainer: document.getElementById('info-box-container'),
                statusDiv: document.getElementById('statusDiv'),
                tickerInput: document.getElementById('tickerInput'),
                fetchBtn: document.getElementById('fetchBtn'),
                dailyBtn: document.getElementById('dailyBtn'),
                weeklyBtn: document.getElementById('weeklyBtn'),
                monthlyBtn: document.getElementById('monthlyBtn'),
                // V1.2 新增算法参数输入框
                priceStdInput: document.getElementById('priceStdInput'),
                volumeStdInput: document.getElementById('volumeStdInput'),
                priceOnlyStdInput: document.getElementById('priceOnlyStdInput'),
                volumeOnlyStdInput: document.getElementById('volumeOnlyStdInput'), // V1.8 新增
                // V1.8 新增复选框
                priceVolumeCheck: document.getElementById('priceVolumeCheck'),
                volumePriceCheck: document.getElementById('volumePriceCheck'),
                priceOnlyCheck: document.getElementById('priceOnlyCheck'),
                volumeOnlyCheck: document.getElementById('volumeOnlyCheck'),
                // ZIG指标DOM
                shortTermZigCheck: document.getElementById('shortTermZigCheck'),
                mediumTermZigCheck: document.getElementById('mediumTermZigCheck'),
                longTermZigCheck: document.getElementById('longTermZigCheck'),
                shortTermZigInput: document.getElementById('shortTermZigInput'),
                mediumTermZigInput: document.getElementById('mediumTermZigInput'),
                longTermZigInput: document.getElementById('longTermZigInput'),
                zigPhaseSourceSelect: document.getElementById('zigPhaseSourceSelect'),
                // V2.0: 成交量ZIG指标DOM
                volumeShortTermZigCheck: document.getElementById('volumeShortTermZigCheck'),
                volumeMediumTermZigCheck: document.getElementById('volumeMediumTermZigCheck'),
                volumeLongTermZigCheck: document.getElementById('volumeLongTermZigCheck'),
                volumeShortTermZigInput: document.getElementById('volumeShortTermZigInput'),
                volumeMediumTermZigInput: document.getElementById('volumeMediumTermZigInput'),
                volumeLongTermZigInput: document.getElementById('volumeLongTermZigInput'),
                volumeZigPhaseSourceSelect: document.getElementById('volumeZigPhaseSourceSelect'),
                // V1.3 新增图例
                chartLegend: document.getElementById('chart-legend'),
                // ---
                addAnnotationBtn: document.getElementById('addAnnotationBtn'),
                exportAnnotationBtn: document.getElementById('exportAnnotationBtn'),
                sortAnnotationBtn: document.getElementById('sortAnnotationBtn'),
                // V4.8.3: 批量控制相关元素
                batchControls: document.getElementById('batchControls'),
                selectedCount: document.getElementById('selectedCount'),
                selectAllBtn: document.getElementById('selectAllBtn'),
                batchAnalyzeBtn: document.getElementById('batchAnalyzeBtn'),
                clearSelectionBtn: document.getElementById('clearSelectionBtn'),
                annotationList: document.getElementById('annotationList'),
                // V5.8.4: 时间筛选相关元素
                timeRangeQuickSelect: document.getElementById('timeRangeQuickSelect'),
                timeFilterCustom: document.getElementById('timeFilterCustom'),
                startDateInput: document.getElementById('startDateInput'),
                endDateInput: document.getElementById('endDateInput'),
                applyCustomDateBtn: document.getElementById('applyCustomDateBtn'),
                timeFilterInfo: document.getElementById('timeFilterInfo'),
                bgColorPicker: document.getElementById('bgColorPicker'),
                textColorPicker: document.getElementById('textColorPicker'),
                fontSizeSlider: document.getElementById('fontSizeSlider'),
                fontSizeValue: document.getElementById('fontSizeValue'),
                buttonSizeSlider: document.getElementById('buttonSizeSlider'),
                buttonSizeValue: document.getElementById('buttonSizeValue'),
                lineColorPicker: document.getElementById('lineColorPicker'),
                opacitySlider: document.getElementById('opacitySlider'),
                opacityValue: document.getElementById('opacityValue'),
                timeSpanThresholdSlider: document.getElementById('timeSpanThresholdSlider'),
                timeSpanThresholdValue: document.getElementById('timeSpanThresholdValue'),
                contentThresholdSlider: document.getElementById('contentThresholdSlider'),
                contentThresholdValue: document.getElementById('contentThresholdValue'),
                zoomStepSlider: document.getElementById('zoomStepSlider'),
                zoomStepValue: document.getElementById('zoomStepValue'),
                // Dialog
                addAnnotationDialog: document.getElementById('addAnnotationDialog'),
                saveAddAnnotationBtn: document.getElementById('saveAddAnnotationBtn'),
                cancelAddAnnotationBtn: document.getElementById('cancelAddAnnotationBtn'),
                addAnnotationDateInput: document.getElementById('addAnnotationDateInput'),
                addAnnotationTextInput: document.getElementById('addAnnotationTextInput'),
                // Edit Dialog
                editAnnotationDialog: document.getElementById('editAnnotationDialog'),
                saveEditAnnotationBtn: document.getElementById('saveEditAnnotationBtn'),
                cancelEditAnnotationBtn: document.getElementById('cancelEditAnnotationBtn'),
                editAnnotationDateInput: document.getElementById('editAnnotationDateInput'),
                editAnnotationTextInput: document.getElementById('editAnnotationTextInput'),
                // Export Dialog
                exportAnnotationDialog: document.getElementById('exportAnnotationDialog'),
                exportStartDateInput: document.getElementById('exportStartDateInput'),
                exportEndDateInput: document.getElementById('exportEndDateInput'),
                confirmExportAnnotationBtn: document.getElementById('confirmExportAnnotationBtn'),
                cancelExportAnnotationBtn: document.getElementById('cancelExportAnnotationBtn'),
                // 侧边栏相关元素
                settingsToggleBtn: document.getElementById('settingsToggleBtn'),
                settingsSidebar: document.getElementById('settingsSidebar'),
                sidebarCloseBtn: document.getElementById('sidebarCloseBtn'),
                container: document.querySelector('.container'),
                // 回收站相关元素
                annotationTab: document.getElementById('annotationTab'),
                recycleTab: document.getElementById('recycleTab'),
                annotationTabContent: document.getElementById('annotationTabContent'),
                recycleTabContent: document.getElementById('recycleTabContent'),
                recycleList: document.getElementById('recycleList'),
                refreshRecycleBtn: document.getElementById('refreshRecycleBtn'),
                // 帮助相关元素
                helpBtn: document.getElementById('helpBtn'),
                helpDialog: document.getElementById('helpDialog'),
                helpTextArea: document.getElementById('helpTextArea'),
                closeHelpBtn: document.getElementById('closeHelpBtn'),
                resetHelpBtn: document.getElementById('resetHelpBtn'),
                saveHelpBtn: document.getElementById('saveHelpBtn'),
            };
            
            // 检查关键DOM元素是否存在
            if (!dom.chartContainer || !dom.statusDiv) {
                console.error("初始化失败：无法找到核心DOM元素。");
                alert("页面加载失败，请刷新重试。");
                return;
            }

            myChart = echarts.init(dom.chartContainer);
            
            setupEventListeners();
            setupStyleControls();
            setupAIModeListeners(); // V5.8: 初始化AI模式监听器
            initializeStyleControls(); // V5.2: 初始化UI控制器值
            initTimeFilter(); // V5.8.4: 初始化时间筛选
            updateUndoRedoButtons();
            updateAnnotationList();

            // 初始化侧边栏状态
            loadSidebarState();

            // V4.8.2: 初始化注释排序偏好
            loadAnnotationSortPreference();

            // 自动获取一次默认股票数据
            fetchStockData(currentTicker, currentPeriod);
        }

        // --- 侧边栏状态管理 ---
        const SIDEBAR_STATE_KEY = 'stockAnalysis_sidebarState';

        // 加载侧边栏状态
        function loadSidebarState() {
            try {
                const saved = localStorage.getItem(SIDEBAR_STATE_KEY);
                if (saved) {
                    sidebarState = JSON.parse(saved);
                    applySidebarState();
                }
            } catch (error) {
                console.warn('加载侧边栏状态失败:', error);
            }
        }

        // 保存侧边栏状态
        function saveSidebarState() {
            try {
                localStorage.setItem(SIDEBAR_STATE_KEY, JSON.stringify(sidebarState));
            } catch (error) {
                console.warn('保存侧边栏状态失败:', error);
            }
        }

        // 应用侧边栏状态
        function applySidebarState() {
            if (sidebarState.isOpen) {
                openSidebar();
            } else {
                closeSidebar();
            }
        }

        // 打开侧边栏
        function openSidebar() {
            sidebarState.isOpen = true;
            dom.settingsSidebar.classList.add('open');
            dom.container.classList.add('sidebar-open');
            saveSidebarState();
        }

        // 关闭侧边栏
        function closeSidebar() {
            sidebarState.isOpen = false;
            dom.settingsSidebar.classList.remove('open');
            dom.container.classList.remove('sidebar-open');
            saveSidebarState();
        }

        // 切换侧边栏状态
        function toggleSidebar() {
            if (sidebarState.isOpen) {
                closeSidebar();
            } else {
                openSidebar();
            }
        }

        // --- 帮助功能 ---
        const HELP_CONTENT_KEY = 'stockAnalysis_helpContent';
        const defaultHelpContent = `📈 股价异动分析系统使用指南

🔍 **基本功能**
• 输入股票代码（如：600000、AAPL、0700）或公司简称
• 支持A股、美股、港股多市场数据分析
• 提供日K、周K、月K线三种时间周期

📊 **图表分析**
• K线图表支持缩放和拖拽查看
• 自动标注异常波动点（价量齐升/跌等）
• 多条移动均线辅助分析趋势

📝 **注释管理**
• 双击异常点可查看详细分析
• 支持手动添加、编辑注释
• AI智能分析异动原因
• 注释可导出为文本格式

⚙️ **个性化设置**
• 调整显示样式和颜色
• 配置异常检测灵敏度
• 自定义注释显示模式

💡 **使用技巧**
• 使用键盘方向键快速浏览
• Ctrl+滚轮缩放图表
• 右键注释获取更多选项`;

        // 显示帮助对话框
        function showHelpDialog() {
            if (!dom.helpDialog) return;
            
            // 加载保存的内容或默认内容
            loadHelpContent();
            
            dom.helpDialog.style.display = 'flex';
            
            // 添加点击外部关闭功能
            setTimeout(() => {
                dom.helpDialog.addEventListener('click', closeHelpOnOutsideClick);
            }, 100);
            
            // ESC键关闭
            document.addEventListener('keydown', closeHelpOnEscape);
        }
        
        // 隐藏帮助对话框
        function hideHelpDialog() {
            if (!dom.helpDialog) return;
            
            dom.helpDialog.style.display = 'none';
            
            // 移除事件监听器
            dom.helpDialog.removeEventListener('click', closeHelpOnOutsideClick);
            document.removeEventListener('keydown', closeHelpOnEscape);
        }
        
        // 点击外部关闭帮助对话框
        function closeHelpOnOutsideClick(e) {
            if (e.target === dom.helpDialog) {
                hideHelpDialog();
            }
        }
        
        // ESC键关闭帮助对话框
        function closeHelpOnEscape(e) {
            if (e.key === 'Escape') {
                hideHelpDialog();
            }
        }
        
        // 重置帮助内容为默认
        function resetHelpContent() {
            if (!dom.helpTextArea) return;
            
            if (confirm('确定要重置为默认使用说明吗？当前的修改将会丢失。')) {
                dom.helpTextArea.value = defaultHelpContent;
                showNotification('✅ 使用说明已重置为默认内容', 'success', 3000);
            }
        }
        
        // 保存帮助内容
        function saveHelpContent() {
            if (!dom.helpTextArea) return;
            
            const content = dom.helpTextArea.value.trim();
            if (!content) {
                showNotification('❌ 使用说明内容不能为空', 'error', 3000);
                return;
            }
            
            // 保存到本地存储
            try {
                localStorage.setItem(HELP_CONTENT_KEY, content);
                showNotification('✅ 使用说明已保存', 'success', 3000);
            } catch (error) {
                console.error('保存使用说明失败:', error);
                showNotification('❌ 保存失败，请稍后重试', 'error', 3000);
            }
        }
        
        // 加载帮助内容
        function loadHelpContent() {
            if (!dom.helpTextArea) return;
            
            try {
                const savedContent = localStorage.getItem(HELP_CONTENT_KEY);
                dom.helpTextArea.value = savedContent || defaultHelpContent;
            } catch (error) {
                console.error('加载使用说明失败:', error);
                dom.helpTextArea.value = defaultHelpContent;
            }
        }

        // --- 事件监听器设置 ---
        function setupEventListeners() {
            // 帮助功能事件监听器
            if (dom.helpBtn) dom.helpBtn.addEventListener('click', showHelpDialog);
            if (dom.closeHelpBtn) dom.closeHelpBtn.addEventListener('click', hideHelpDialog);
            if (dom.resetHelpBtn) dom.resetHelpBtn.addEventListener('click', resetHelpContent);
            if (dom.saveHelpBtn) dom.saveHelpBtn.addEventListener('click', saveHelpContent);
            
            // 侧边栏事件监听器
            dom.settingsToggleBtn.addEventListener('click', toggleSidebar);
            dom.sidebarCloseBtn.addEventListener('click', closeSidebar);
            
            // 点击侧边栏外部关闭侧边栏（仅在移动端）
            document.addEventListener('click', (e) => {
                if (window.innerWidth <= 768 && sidebarState.isOpen) {
                    if (!dom.settingsSidebar.contains(e.target) && !dom.settingsToggleBtn.contains(e.target)) {
                        closeSidebar();
                    }
                }
            });

            // ESC键关闭侧边栏
            document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape' && sidebarState.isOpen) {
                    closeSidebar();
                }
            });
            
            // 图表键盘控制事件监听器
            dom.chartContainer.addEventListener('keydown', handleChartKeyboard);
            
            // V5.2: 鼠标位置跟踪监听器（用于智能缩放）
            dom.chartContainer.addEventListener('mousemove', handleChartMouseMove);
            
            // 点击图表时自动获得焦点，方便键盘控制
            dom.chartContainer.addEventListener('click', () => {
                dom.chartContainer.focus();
            });
            
            dom.fetchBtn.addEventListener('click', () => {
                const ticker = dom.tickerInput.value.trim();
                if (ticker) {
                    fetchStockData(ticker, currentPeriod);
                }
            });

            dom.tickerInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') dom.fetchBtn.click();
            });

            dom.dailyBtn.addEventListener('click', () => setPeriod('1d'));
            dom.weeklyBtn.addEventListener('click', () => setPeriod('1wk'));
            dom.monthlyBtn.addEventListener('click', () => setPeriod('1mo'));
            
            // V1.2: 当算法参数变化时，自动重新获取数据
            const algoInputs = [
                dom.priceStdInput, dom.volumeStdInput, dom.priceOnlyStdInput, dom.volumeOnlyStdInput,
                dom.shortTermZigInput, dom.mediumTermZigInput, dom.longTermZigInput, dom.zigPhaseSourceSelect,
                // V2.0: 新增成交量ZIG输入框
                dom.volumeShortTermZigInput, dom.volumeMediumTermZigInput, dom.volumeLongTermZigInput, dom.volumeZigPhaseSourceSelect
            ];
            algoInputs.forEach(input => {
                if(input) {
                    input.addEventListener('change', () => {
                        const ticker = dom.tickerInput.value.trim();
                        if (ticker) {
                            fetchStockData(ticker, currentPeriod);
                        }
                    });
                }
            });

            // V1.8: 当复选框状态变化时，重新渲染注释
            const annotationCheckboxes = [
                dom.priceVolumeCheck, dom.volumePriceCheck, dom.priceOnlyCheck, dom.volumeOnlyCheck,
                dom.shortTermZigCheck, dom.mediumTermZigCheck, dom.longTermZigCheck,
                // V2.0: 新增成交量ZIG复选框
                dom.volumeShortTermZigCheck, dom.volumeMediumTermZigCheck, dom.volumeLongTermZigCheck
            ];
            annotationCheckboxes.forEach(checkbox => {
                if(checkbox) {
                    checkbox.addEventListener('change', () => {
                        // V2.2 BUG修复: 复选框变化时应重绘整个图表以更新series，而不是只更新注释
                        if (checkbox.id.includes('ZigCheck')) {
                            renderChart();
                        } else {
                            renderCustomAnnotations();
                        }

                        // V5.8.4: 同步更新注释管理面板和批量控制状态
                        updateAnnotationList();
                        updateBatchControls();
                        updateTimeFilterInfo(); // 更新筛选信息显示的数量
                    });
                }
            });

            dom.addAnnotationBtn.addEventListener('click', showAddAnnotationDialog);
            dom.saveAddAnnotationBtn.addEventListener('click', saveNewAnnotation);
            dom.cancelAddAnnotationBtn.addEventListener('click', hideAddAnnotationDialog);
            
            // V4.8.2: 排序按钮事件
            dom.sortAnnotationBtn.addEventListener('click', toggleAnnotationSort);
            
            // Export annotation dialog events
            dom.exportAnnotationBtn.addEventListener('click', showExportAnnotationDialog);
            dom.confirmExportAnnotationBtn.addEventListener('click', exportAnnotationData);
            dom.cancelExportAnnotationBtn.addEventListener('click', hideExportAnnotationDialog);
            
            // Edit annotation dialog events
            dom.saveEditAnnotationBtn.addEventListener('click', saveEditAnnotation);
            dom.cancelEditAnnotationBtn.addEventListener('click', hideEditAnnotationDialog);

            // 回收站标签页事件
            dom.annotationTab.addEventListener('click', () => switchTab('annotation'));
            dom.recycleTab.addEventListener('click', () => switchTab('recycle'));
            dom.refreshRecycleBtn.addEventListener('click', loadRecycleData);
            
            // V4.8.4: 批量分析事件监听器
            if (dom.selectAllBtn) {
                dom.selectAllBtn.addEventListener('click', selectAllAnnotations);
            }
            if (dom.batchAnalyzeBtn) {
                dom.batchAnalyzeBtn.addEventListener('click', performBatchAnalysis);
            }
            if (dom.clearSelectionBtn) {
                dom.clearSelectionBtn.addEventListener('click', clearAllSelections);
            }

            window.addEventListener('resize', () => {
                if (myChart) {
                    myChart.resize();
                    renderCustomAnnotations();
                }
            });
        }
        
        // --- 图表键盘控制功能 ---
        // V5.3: 十字光标位置状态
        let crosshairPosition = {
            dataIndex: -1,
            isActive: false
        };
        
        function handleChartKeyboard(event) {
            // 确保图表已初始化
            if (!myChart) return;
            
            // 检查是否是方向键
            const arrowKeys = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
            if (!arrowKeys.includes(event.key)) return;
            
            // 阻止默认行为（页面滚动）
            event.preventDefault();
            event.stopPropagation();
            
            try {
                switch (event.key) {
                    case 'ArrowUp':
                        zoomChart('in');
                        break;
                    case 'ArrowDown':
                        zoomChart('out');
                        break;
                    case 'ArrowLeft':
                        moveCrosshair('left');
                        break;
                    case 'ArrowRight':
                        moveCrosshair('right');
                        break;
                }
            } catch (error) {
                console.error('键盘控制出错:', error);
            }
        }
        
        // V5.3: 十字光标移动功能
        function moveCrosshair(direction) {
            if (!myChart) return;
            
            const option = myChart.getOption();
            const dataZoom = option.dataZoom[0];
            const totalData = option.xAxis[0].data.length;
            
            // 计算当前可视区域的数据范围
            const start = dataZoom.start || 0;
            const end = dataZoom.end || 100;
            const visibleStart = Math.floor((start / 100) * totalData);
            const visibleEnd = Math.floor((end / 100) * totalData);
            const visibleRange = visibleEnd - visibleStart;
            
            // 初始化十字光标位置（如果未激活）
            if (!crosshairPosition.isActive) {
                crosshairPosition.dataIndex = Math.floor(visibleStart + visibleRange / 2);
                crosshairPosition.isActive = true;
            }
            
            // 移动十字光标
            if (direction === 'left') {
                crosshairPosition.dataIndex = Math.max(0, crosshairPosition.dataIndex - 1);
                
                // 如果移动到可视区域左边界，触发图表左移
                if (crosshairPosition.dataIndex < visibleStart && visibleStart > 0) {
                    panChart('left');
                    return;
                }
                
            } else if (direction === 'right') {
                crosshairPosition.dataIndex = Math.min(totalData - 1, crosshairPosition.dataIndex + 1);
                
                // 如果移动到可视区域右边界，触发图表右移
                if (crosshairPosition.dataIndex >= visibleEnd && visibleEnd < totalData) {
                    panChart('right');
                    return;
                }
            }
            
            // 更新十字光标位置
            updateCrosshairPosition();
        }
        
        // V5.3: 更新十字光标到指定位置
        function updateCrosshairPosition() {
            if (!myChart || !crosshairPosition.isActive) return;
            
            const option = myChart.getOption();
            const dates = option.xAxis[0].data;
            const klineData = option.series[0].data;
            
            if (crosshairPosition.dataIndex >= 0 && crosshairPosition.dataIndex < dates.length) {
                const targetDate = dates[crosshairPosition.dataIndex];
                const targetKline = klineData[crosshairPosition.dataIndex];
                
                if (targetKline) {
                    // 使用ECharts的showTip API来显示十字光标
                    myChart.dispatchAction({
                        type: 'showTip',
                        seriesIndex: 0,
                        dataIndex: crosshairPosition.dataIndex,
                        name: targetDate
                    });
                }
            }
        }
        
        // V5.2: 处理图表鼠标移动事件，记录鼠标位置用于智能缩放
        function handleChartMouseMove(event) {
            if (!myChart) return;
            
            try {
                // 获取图表容器的位置
                const chartRect = dom.chartContainer.getBoundingClientRect();
                
                // 计算相对于图表的坐标
                const chartX = event.clientX - chartRect.left;
                const chartY = event.clientY - chartRect.top;
                
                // 使用ECharts的convertFromPixel来获取对应的数据坐标
                const dataCoord = myChart.convertFromPixel({ gridIndex: 0 }, [chartX, chartY]);
                
                if (dataCoord && dataCoord.length >= 2) {
                    const dataIndex = Math.round(dataCoord[0]);
                    const chartOption = myChart.getOption();
                    
                    if (chartOption && chartOption.xAxis && chartOption.xAxis[0].data) {
                        const allDates = chartOption.xAxis[0].data;
                        
                        if (dataIndex >= 0 && dataIndex < allDates.length) {
                            // 更新鼠标位置信息
                            lastMousePosition = {
                                x: chartX,
                                y: chartY,
                                dataIndex: dataIndex,
                                isValid: true
                            };
                            
                            // V5.3: 鼠标移动时同步更新十字光标位置状态
                            if (crosshairPosition.isActive) {
                                crosshairPosition.dataIndex = dataIndex;
                            }
                        }
                    }
                } else {
                    // 鼠标不在有效的数据区域内
                    lastMousePosition.isValid = false;
                }
            } catch (error) {
                // 坐标转换失败，可能鼠标在图表范围外
                lastMousePosition.isValid = false;
            }
        }
        
        function getCurrentDataZoom() {
            if (!myChart) return null;
            
            const option = myChart.getOption();
            if (!option || !option.dataZoom || !option.dataZoom[0]) return null;
            
            const dataZoom = option.dataZoom[0];
            return {
                start: typeof dataZoom.start === 'number' ? dataZoom.start : 0,
                end: typeof dataZoom.end === 'number' ? dataZoom.end : 100
            };
        }
        
        function updateDataZoom(start, end) {
            if (!myChart) return;
            
            // 确保start和end在合理范围内
            start = Math.max(0, Math.min(100, start));
            end = Math.max(0, Math.min(100, end));
            
            // 确保start < end，并且范围不会太小
            if (end - start < 1) {
                if (start > 50) {
                    start = end - 1;
                } else {
                    end = start + 1;
                }
            }
            
            // 使用dispatchAction更新dataZoom
            myChart.dispatchAction({
                type: 'dataZoom',
                dataZoomIndex: 0,
                start: start,
                end: end
            });
        }
        
        function zoomChart(direction) {
            const current = getCurrentDataZoom();
            if (!current) return;
            
            const zoomStep = styleSettings.zoomStep; // V5.2: 使用用户设置的缩放比例
            const currentRange = current.end - current.start;
            let newStart, newEnd;
            
            // V5.2: 智能缩放 - 以鼠标位置为中心进行缩放
            if (lastMousePosition.isValid && lastMousePosition.dataIndex !== null) {
                try {
                    // 获取图表数据总长度
                    const chartOption = myChart.getOption();
                    if (!chartOption || !chartOption.xAxis || !chartOption.xAxis[0].data) {
                        // 如果无法获取图表数据，回退到传统的中心缩放
                        return fallbackCenterZoom(direction, current, zoomStep);
                    }
                    
                    const totalDataLength = chartOption.xAxis[0].data.length;
                    
                    // 将鼠标位置的数据索引转换为百分比
                    const mouseDataPercentage = (lastMousePosition.dataIndex / (totalDataLength - 1)) * 100;
                    
                    // 确保鼠标位置在当前视图范围内
                    if (mouseDataPercentage < current.start || mouseDataPercentage > current.end) {
                        // 鼠标位置不在当前视图内，回退到传统缩放
                        return fallbackCenterZoom(direction, current, zoomStep);
                    }
                    
                    // 计算鼠标位置在当前视图中的相对位置
                    const relativePosition = Math.max(0, Math.min(1, (mouseDataPercentage - current.start) / currentRange));
                    
                    if (direction === 'in') {
                        // 放大 - 减少显示范围，保持鼠标位置相对不变
                        const newRange = Math.max(1, currentRange - zoomStep);
                        const rangeReduction = currentRange - newRange;
                        
                        // 根据鼠标的相对位置分配缩减的范围
                        const leftReduction = rangeReduction * relativePosition;
                        const rightReduction = rangeReduction * (1 - relativePosition);
                        
                        newStart = current.start + leftReduction;
                        newEnd = current.end - rightReduction;
                    } else {
                        // 缩小 - 增加显示范围，保持鼠标位置相对不变
                        const newRange = Math.min(100, currentRange + zoomStep);
                        const rangeIncrease = newRange - currentRange;
                        
                        // 根据鼠标的相对位置分配增加的范围
                        const leftIncrease = rangeIncrease * relativePosition;
                        const rightIncrease = rangeIncrease * (1 - relativePosition);
                        
                        newStart = current.start - leftIncrease;
                        newEnd = current.end + rightIncrease;
                    }
                    
                    // 边界检查
                    newStart = Math.max(0, newStart);
                    newEnd = Math.min(100, newEnd);
                    
                } catch (error) {
                    console.warn('智能缩放计算失败，使用传统缩放:', error);
                    return fallbackCenterZoom(direction, current, zoomStep);
                }
            } else {
                // 没有有效的鼠标位置，使用传统的中心缩放
                return fallbackCenterZoom(direction, current, zoomStep);
            }
            
            updateDataZoom(newStart, newEnd);
        }
        
        // V5.2: 传统的中心缩放方法（作为备选方案）
        function fallbackCenterZoom(direction, current, zoomStep) {
            const currentRange = current.end - current.start;
            const center = (current.start + current.end) / 2;
            let newStart, newEnd;
            
            if (direction === 'in') {
                // 放大 - 减少显示范围
                const newRange = Math.max(1, currentRange - zoomStep);
                const adjustment = (currentRange - newRange) / 2;
                newStart = current.start + adjustment;
                newEnd = current.end - adjustment;
            } else {
                // 缩小 - 增加显示范围
                const newRange = Math.min(100, currentRange + zoomStep);
                const adjustment = (newRange - currentRange) / 2;
                newStart = current.start - adjustment;
                newEnd = current.end + adjustment;
            }
            
            updateDataZoom(newStart, newEnd);
        }
        
        function panChart(direction) {
            const current = getCurrentDataZoom();
            if (!current) return;
            
            const currentRange = current.end - current.start;
            const panStep = currentRange * 0.2; // 每次平移当前视图宽度的20%
            
            let newStart, newEnd;
            
            if (direction === 'left') {
                // 向左平移
                newStart = current.start - panStep;
                newEnd = current.end - panStep;
                
                // 边界检查
                if (newStart < 0) {
                    newStart = 0;
                    newEnd = currentRange;
                }
            } else {
                // 向右平移
                newStart = current.start + panStep;
                newEnd = current.end + panStep;
                
                // 边界检查
                if (newEnd > 100) {
                    newEnd = 100;
                    newStart = 100 - currentRange;
                }
            }
            
            updateDataZoom(newStart, newEnd);
        }
        
        // --- V4.8.2: 注释排序功能 ---
        function toggleAnnotationSort() {
            // 切换排序方式
            annotationSortOrder = annotationSortOrder === 'desc' ? 'asc' : 'desc';
            
            // 更新按钮显示
            updateSortButtonDisplay();
            
            // 保存排序偏好
            localStorage.setItem('annotationSortOrder', annotationSortOrder);
            
            // 重新渲染注释列表
            updateAnnotationList();
            
            // 显示提示
            const orderText = annotationSortOrder === 'desc' ? '降序（最新在前）' : '升序（最早在前）';
            showNotification(`📅 注释排序已切换为${orderText}`, 'info', 2000);
        }
        
        function updateSortButtonDisplay() {
            if (!dom.sortAnnotationBtn) return;
            
            if (annotationSortOrder === 'desc') {
                dom.sortAnnotationBtn.innerHTML = '📅 ↓';
                dom.sortAnnotationBtn.title = '当前：降序（最新在前），点击切换为升序';
            } else {
                dom.sortAnnotationBtn.innerHTML = '📅 ↑';
                dom.sortAnnotationBtn.title = '当前：升序（最早在前），点击切换为降序';
            }
        }
        
        function sortAnnotations(annotations, order = 'desc') {
            return [...annotations].sort((a, b) => {
                const dateA = new Date(a.date);
                const dateB = new Date(b.date);
                
                if (order === 'desc') {
                    return dateB - dateA; // 降序：新日期在前
                } else {
                    return dateA - dateB; // 升序：旧日期在前
                }
            });
        }
        
        function loadAnnotationSortPreference() {
            const savedOrder = localStorage.getItem('annotationSortOrder');
            if (savedOrder && ['asc', 'desc'].includes(savedOrder)) {
                annotationSortOrder = savedOrder;
            }
            updateSortButtonDisplay();
        }
        
        // --- V4.8.3: 批量分析功能 ---
        function toggleAnnotationSelection(annotationId) {
            if (batchAnalysisState.selectedAnnotations.has(annotationId)) {
                batchAnalysisState.selectedAnnotations.delete(annotationId);
            } else {
                batchAnalysisState.selectedAnnotations.add(annotationId);
            }
            
            updateBatchControls();
            updateAnnotationList(); // 重新渲染以更新选中状态
        }
        
        function updateBatchControls() {
            const selectedCount = batchAnalysisState.selectedAnnotations.size;
            const hasSelection = selectedCount > 0;
            
            // 更新选中数量显示
            if (dom.selectedCount) {
                dom.selectedCount.textContent = `已选中 ${selectedCount} 项`;
            }
            
            // 显示/隐藏批量控制区域
            if (dom.batchControls) {
                dom.batchControls.style.display = hasSelection ? 'flex' : 'none';
            }
            
            // 更新全选按钮状态
            updateSelectAllButtonState();
            
            // 更新所有批量控制按钮状态
            updateBatchControlsState();
        }
        
        function updateSelectAllButtonState() {
            if (!dom.selectAllBtn) return;
            
            const visibleAnnotationsCount = getVisibleAnnotations().length;
            const selectedCount = batchAnalysisState.selectedAnnotations.size;
            
            if (selectedCount === 0) {
                dom.selectAllBtn.textContent = '📋 全选';
                dom.selectAllBtn.title = '全选所有可见注释';
            } else if (selectedCount === visibleAnnotationsCount) {
                dom.selectAllBtn.textContent = '📋 取消全选';
                dom.selectAllBtn.title = '取消选择所有注释';
            } else {
                dom.selectAllBtn.textContent = '📋 全选';
                dom.selectAllBtn.title = '全选所有可见注释';
            }
        }
        
        function getVisibleAnnotations() {
            // 获取当前可见的注释（应用过滤条件）
            const enabledAnnotationTypes = new Set();
            if (dom.priceVolumeCheck && dom.priceVolumeCheck.checked) enabledAnnotationTypes.add('price_volume');
            if (dom.volumePriceCheck && dom.volumePriceCheck.checked) enabledAnnotationTypes.add('volume_stable_price');
            if (dom.priceOnlyCheck && dom.priceOnlyCheck.checked) enabledAnnotationTypes.add('price_only');
            if (dom.volumeOnlyCheck && dom.volumeOnlyCheck.checked) enabledAnnotationTypes.add('volume_only');

            let visibleAnnotations = currentAnnotations.filter(anno =>
                enabledAnnotationTypes.has(anno.type) ||
                anno.type === 'manual' ||
                anno.algorithm_type === 'ai_analysis'  // 修复：检查algorithm_type而不是type
            );

            // V5.8.4: 应用时间筛选
            if (timeFilterState.enabled && timeFilterState.mode !== 'all') {
                visibleAnnotations = applyTimeFilter(visibleAnnotations);
            }

            return visibleAnnotations;
        }
        
        function selectAllAnnotations() {
            const visibleAnnotations = getVisibleAnnotations();
            const allSelected = visibleAnnotations.every(anno => 
                batchAnalysisState.selectedAnnotations.has(anno.id)
            );
            
            if (allSelected) {
                // 如果全部已选中，则取消全选
                visibleAnnotations.forEach(anno => {
                    batchAnalysisState.selectedAnnotations.delete(anno.id);
                });
                showNotification('✖ 已取消全选', 'info', 1500);
            } else {
                // 否则全选所有可见注释
                visibleAnnotations.forEach(anno => {
                    batchAnalysisState.selectedAnnotations.add(anno.id);
                });
                showNotification(`📋 已选中 ${visibleAnnotations.length} 项注释`, 'success', 1500);
            }
            
            updateBatchControls();
            updateAnnotationList();
        }
        
        function clearAllSelections() {
            const selectedCount = batchAnalysisState.selectedAnnotations.size;
            batchAnalysisState.selectedAnnotations.clear();
            
            updateBatchControls();
            updateAnnotationList();
            
            if (selectedCount > 0) {
                showNotification(`✖ 已取消选择 ${selectedCount} 项注释`, 'info', 1500);
            }
        }
        
        // --- V4.8.4: 批量分析引擎 ---
        async function performBatchAnalysis() {
            const selectedAnnotations = Array.from(batchAnalysisState.selectedAnnotations);
            if (selectedAnnotations.length === 0) {
                showNotification('⚠️ 请先选择要分析的注释', 'warning', 2000);
                return;
            }

            // V5.7.4: 智能批量分析过滤 - 分离需要分析和已分析的注释
            const needAnalysis = [];
            const alreadyAnalyzed = [];

            selectedAnnotations.forEach(annotationId => {
                const annotation = currentAnnotations.find(anno => anno.id === annotationId);
                if (annotation) {
                    if (annotation.algorithm_type === 'ai_analysis') {
                        alreadyAnalyzed.push(annotation);
                    } else {
                        needAnalysis.push(annotation);
                    }
                }
            });

            console.log(`[批量分析] 智能分析: ${needAnalysis.length}个需分析, ${alreadyAnalyzed.length}个已分析`);

            // 构建最终的处理队列
            let finalProcessingQueue = [...needAnalysis.map(a => a.id)];

            // 如果有已分析的注释，询问用户是否重新分析
            if (alreadyAnalyzed.length > 0) {
                const reAnalyzeConfirm = confirm(
                    `发现 ${alreadyAnalyzed.length} 个注释已有AI分析结果：\n` +
                    alreadyAnalyzed.map(a => `• ${a.date}`).join('\n') +
                    `\n\n是否重新分析这些注释？\n点击"确定"重新分析，"取消"跳过这些注释。`
                );

                if (reAnalyzeConfirm) {
                    finalProcessingQueue.push(...alreadyAnalyzed.map(a => a.id));
                    showNotification(`📝 将重新分析 ${alreadyAnalyzed.length} 个已分析注释`, 'info', 3000);
                } else {
                    showNotification(`⏭️ 跳过 ${alreadyAnalyzed.length} 个已分析注释`, 'info', 2000);
                }
            }

            if (finalProcessingQueue.length === 0) {
                showNotification('ℹ️ 没有需要分析的注释', 'info', 2000);
                return;
            }

            // 初始化批量分析状态
            batchAnalysisState.isProcessing = true;
            batchAnalysisState.isCancelled = false;
            batchAnalysisState.processedCount = 0;
            batchAnalysisState.totalCount = finalProcessingQueue.length;
            batchAnalysisState.processingQueue = [...finalProcessingQueue];
            batchAnalysisState.currentBatch = [];
            
            // 更新批量分析按钮状态
            updateBatchControlsState();

            showNotification(`🚀 开始批量分析 ${selectedAnnotations.length} 个注释...`, 'info', 2000);

            try {
                await processBatchQueue();
            } catch (error) {
                console.error('批量分析过程中发生错误:', error);
                showNotification('❌ 批量分析过程中发生错误', 'error', 3000);
            } finally {
                // 生成详细的完成报告
                const totalTasks = batchAnalysisState.totalCount;
                const successCount = batchAnalysisState.processedCount - batchAnalysisState.failedTasks.size;
                const failedCount = batchAnalysisState.failedTasks.size;

                // 清理状态
                batchAnalysisState.isProcessing = false;
                batchAnalysisState.isCancelled = false;
                batchAnalysisState.currentBatch = [];
                batchAnalysisState.processingQueue = [];

                // 隐藏进度指示器
                hideBatchProgressIndicator();

                updateBatchControlsState();

                // 显示完成结果
                if (!batchAnalysisState.isCancelled) {
                    clearAllSelections();

                    if (failedCount === 0) {
                        showNotification(`✅ 批量分析完成! 成功分析 ${successCount} 个注释`, 'success', 5000);
                    } else if (successCount > 0) {
                        showNotification(`⚠️ 批量分析完成! 成功: ${successCount}, 失败: ${failedCount}`, 'warning', 8000);
                    } else {
                        showNotification(`❌ 批量分析失败! 所有 ${totalTasks} 个任务都失败了`, 'error', 8000);
                    }

                    // 如果有失败的任务，提供恢复建议
                    if (failedCount > 0) {
                        setTimeout(() => {
                            showNotification(`💡 提示: 可以重新选择失败的注释进行单独分析`, 'info', 6000);
                        }, 3000);
                    }

                    // 刷新注释列表以显示最新状态
                    setTimeout(() => {
                        loadAnnotations();
                    }, 1000);
                }

                // 清理失败任务记录（分析完成后）
                batchAnalysisState.failedTasks.clear();
            }
        }
        
        async function processBatchQueue() {
            while (batchAnalysisState.processingQueue.length > 0 && !batchAnalysisState.isCancelled) {
                // 准备当前批次（最多10个）
                const batchSize = Math.min(
                    batchAnalysisState.maxConcurrent, 
                    batchAnalysisState.processingQueue.length
                );
                
                batchAnalysisState.currentBatch = batchAnalysisState.processingQueue.splice(0, batchSize);
                
                // 并行处理当前批次 - 简化版本，回归基本逻辑
                const promises = batchAnalysisState.currentBatch.map(async (annotationId) => {
                    if (batchAnalysisState.isCancelled) return;

                    try {
                        const annotation = currentAnnotations.find(anno => anno.id === annotationId);
                        if (!annotation) {
                            console.warn(`[批量分析] 找不到注释 ${annotationId}`);
                            return;
                        }

                        console.log(`[批量分析] 开始分析注释 ${annotationId}`);

                        // V5.7.4: 恢复批量分析的彩虹视觉反馈
                        const analysisPromise = performAIAnalysisCore(annotation);
                        globalAIAnalysisState.start(annotationId, analysisPromise);

                        try {
                            await analysisPromise;
                            globalAIAnalysisState.complete(annotationId);
                        } catch (analysisError) {
                            globalAIAnalysisState.complete(annotationId);
                            throw analysisError; // 重新抛出错误让外层catch处理
                        }

                        console.log(`[批量分析] 注释 ${annotationId} 分析成功`);

                    } catch (error) {
                        console.error(`[批量分析] 注释 ${annotationId} 分析失败:`, error);
                        // 简单记录失败，不做复杂的重试
                        batchAnalysisState.failedTasks.add(annotationId);
                    } finally {
                        // 更新进度
                        batchAnalysisState.processedCount++;
                        updateBatchProgress();
                    }
                });
                
                // 等待当前批次完成
                await Promise.all(promises);
                
                // 清空当前批次
                batchAnalysisState.currentBatch = [];

                // 简化：不需要额外延迟，之前10个并发都工作正常
            }
        }
        
        
        function updateBatchControlsState() {
            // 更新批量分析按钮状态
            if (dom.batchAnalyzeBtn) {
                if (batchAnalysisState.isProcessing) {
                    dom.batchAnalyzeBtn.textContent = '🤖 批量分析中...';
                    dom.batchAnalyzeBtn.disabled = true;
                    dom.batchAnalyzeBtn.classList.add('loading');
                    // 添加彩虹背景动画效果
                    dom.batchAnalyzeBtn.style.background = 'linear-gradient(45deg, #ff6b6b, #4ecdc4, #45b7d1, #96ceb4, #ffa726, #ab47bc)';
                    dom.batchAnalyzeBtn.style.backgroundSize = '400% 400%';
                    dom.batchAnalyzeBtn.style.animation = 'rainbow-pulse 2s ease-in-out infinite';
                    dom.batchAnalyzeBtn.style.color = 'white';
                    dom.batchAnalyzeBtn.style.position = 'relative';
                    dom.batchAnalyzeBtn.style.zIndex = '10';
                    
                    // 为选中的项目添加彩虹边框动画
                    updateSelectedItemsAnimation(true);
                } else {
                    dom.batchAnalyzeBtn.textContent = '🤖 批量分析';
                    dom.batchAnalyzeBtn.disabled = batchAnalysisState.selectedAnnotations.size === 0;
                    dom.batchAnalyzeBtn.classList.remove('loading');
                    // 清理彩虹动画样式，恢复紫色渐变底色
                    dom.batchAnalyzeBtn.style.background = 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)';
                    dom.batchAnalyzeBtn.style.backgroundSize = '';
                    dom.batchAnalyzeBtn.style.animation = '';
                    dom.batchAnalyzeBtn.style.color = '';
                    dom.batchAnalyzeBtn.style.position = '';
                    dom.batchAnalyzeBtn.style.zIndex = '';
                    
                    // 移除选中项目的边框闪烁动画
                    updateSelectedItemsAnimation(false);
                }
            }
            
            // 禁用其他控制按钮
            const controlButtons = [dom.selectAllBtn, dom.clearSelectionBtn];
            controlButtons.forEach(btn => {
                if (btn) {
                    btn.disabled = batchAnalysisState.isProcessing;
                }
            });
        }
        
        // 更新选中项目的边框闪烁动画状态
        function updateSelectedItemsAnimation(isProcessing) {
            // 获取所有选中的注释项
            const selectedItems = document.querySelectorAll('.annotation-item.selected');
            
            selectedItems.forEach(item => {
                if (isProcessing) {
                    item.classList.add('processing');
                } else {
                    item.classList.remove('processing');
                }
            });
            
            console.log(`[批量分析] 更新 ${selectedItems.length} 个选中项目的边框闪烁动画: ${isProcessing ? '开启' : '关闭'}`);
        }
        
        // --- 样式控制 ---
        function setupStyleControls() {
             const controls = {
                bgColorPicker: (e) => { styleSettings.bgColor = e.target.value; applyStyleSettings(); saveStyleSettings(); },
                textColorPicker: (e) => { styleSettings.textColor = e.target.value; applyStyleSettings(); saveStyleSettings(); },
                fontSizeSlider: (e) => { 
                    styleSettings.fontSize = parseInt(e.target.value); 
                    dom.fontSizeValue.textContent = styleSettings.fontSize + 'px';
                    applyStyleSettings(); 
                    saveStyleSettings();
                },
                buttonSizeSlider: (e) => {
                    const size = e.target.value + 'px';
                    document.documentElement.style.setProperty('--annotation-button-size', size);
                    dom.buttonSizeValue.textContent = size;
                    // 按钮大小不需要保存到styleSettings，因为它是CSS变量
                },
                lineColorPicker: (e) => { styleSettings.lineColor = e.target.value; applyStyleSettings(); saveStyleSettings(); },
                opacitySlider: (e) => { 
                    styleSettings.opacity = parseFloat(e.target.value); 
                    dom.opacityValue.textContent = styleSettings.opacity;
                    applyStyleSettings(); 
                    saveStyleSettings();
                },
                timeSpanThresholdSlider: (e) => { 
                    styleSettings.timeSpanThreshold = parseInt(e.target.value); 
                    dom.timeSpanThresholdValue.textContent = styleSettings.timeSpanThreshold + '天';
                    renderCustomAnnotations(); // 重新渲染注释以应用新设置
                    saveStyleSettings();
                },
                contentThresholdSlider: (e) => { 
                    styleSettings.contentThreshold = parseInt(e.target.value); 
                    dom.contentThresholdValue.textContent = styleSettings.contentThreshold + '字符';
                    renderCustomAnnotations(); // 重新渲染注释以应用新设置
                    saveStyleSettings();
                },
                zoomStepSlider: (e) => { 
                    styleSettings.zoomStep = parseInt(e.target.value); 
                    dom.zoomStepValue.textContent = styleSettings.zoomStep + '%';
                    saveStyleSettings();
                }
            };
            
             Object.entries(controls).forEach(([id, handler]) => {
                const element = document.getElementById(id);
                if(element) element.addEventListener('input', handler);
            });
        }
        
        // V5.2: 初始化UI控制器的值以反映加载的设置
        function initializeStyleControls() {
            try {
                // 设置颜色选择器
                if (dom.bgColorPicker) dom.bgColorPicker.value = styleSettings.bgColor;
                if (dom.textColorPicker) dom.textColorPicker.value = styleSettings.textColor;
                if (dom.lineColorPicker) dom.lineColorPicker.value = styleSettings.lineColor;
                
                // 设置滑动条和对应的值显示
                if (dom.fontSizeSlider) {
                    dom.fontSizeSlider.value = styleSettings.fontSize;
                    if (dom.fontSizeValue) dom.fontSizeValue.textContent = styleSettings.fontSize + 'px';
                }
                
                if (dom.opacitySlider) {
                    dom.opacitySlider.value = styleSettings.opacity;
                    if (dom.opacityValue) dom.opacityValue.textContent = styleSettings.opacity;
                }
                
                if (dom.timeSpanThresholdSlider) {
                    dom.timeSpanThresholdSlider.value = styleSettings.timeSpanThreshold;
                    if (dom.timeSpanThresholdValue) dom.timeSpanThresholdValue.textContent = styleSettings.timeSpanThreshold + '天';
                }
                
                // 内容完善阈值设置
                if (dom.contentThresholdSlider) {
                    dom.contentThresholdSlider.value = styleSettings.contentThreshold;
                    if (dom.contentThresholdValue) dom.contentThresholdValue.textContent = styleSettings.contentThreshold + '字符';
                }
                
                // V5.2: 缩放步长设置
                if (dom.zoomStepSlider) {
                    dom.zoomStepSlider.value = styleSettings.zoomStep;
                    if (dom.zoomStepValue) dom.zoomStepValue.textContent = styleSettings.zoomStep + '%';
                }
                
            } catch (error) {
                console.warn('初始化样式控制器失败:', error);
            }
        }

        function applyStyleSettings() {
            dom.infoBoxContainer.querySelectorAll('.annotation-box').forEach(box => {
                box.style.backgroundColor = styleSettings.bgColor;
                box.style.opacity = styleSettings.opacity;
                const textElement = box.querySelector('.annotation-text');
                if (textElement) {
                    textElement.style.color = styleSettings.textColor;
                    textElement.style.fontSize = styleSettings.fontSize + 'px';
                }
            });

            dom.infoBoxContainer.querySelectorAll('.annotation-arrow-line').forEach(line => {
                line.setAttribute('stroke', styleSettings.lineColor);
            });

            dom.infoBoxContainer.querySelectorAll('.annotation-arrow-head').forEach(head => {
                head.setAttribute('fill', styleSettings.lineColor);
                head.setAttribute('stroke', styleSettings.lineColor);
            });
        }

        // --- 数据获取与处理 ---
        function setPeriod(period) {
            currentPeriod = period;
            document.querySelectorAll('.period-btn').forEach(btn => btn.classList.remove('active'));
            const activeBtn = period === '1d' ? dom.dailyBtn : period === '1wk' ? dom.weeklyBtn : dom.monthlyBtn;
            if(activeBtn) activeBtn.classList.add('active');
            
            const ticker = dom.tickerInput.value.trim();
            if (ticker) {
                fetchStockData(ticker, currentPeriod);
            }
        }
        
        async function fetchStockData(ticker, period) {
            if (!dom.statusDiv) {
                console.error("无法更新状态，statusDiv 未找到。");
                return;
            }
            dom.statusDiv.innerHTML = `<div class="loading">⏳ 正在获取 ${ticker} 数据...</div>`;
            
            if (ticker !== currentTicker) {
                // 重置状态，但保留算法参数
                currentTicker = ticker;
                currentAnnotations = [];
                annotationHistory = [];
                historyIndex = -1;
            }
            
            // V1.2: 读取算法参数并构建API请求URL
            const priceStd = dom.priceStdInput.value;
            const volumeStd = dom.volumeStdInput.value;
            const priceOnlyStd = dom.priceOnlyStdInput.value;
            const volumeOnlyStd = dom.volumeOnlyStdInput.value; // V1.8 新增
            const shortTermZig = dom.shortTermZigInput.value;
            const mediumTermZig = dom.mediumTermZigInput.value;
            const longTermZig = dom.longTermZigInput.value;
            const zigPhaseSource = dom.zigPhaseSourceSelect.value;
            
            // V2.0: 读取成交量ZIG参数
            const volumeShortTermZig = dom.volumeShortTermZigInput.value;
            const volumeMediumTermZig = dom.volumeMediumTermZigInput.value;
            const volumeLongTermZig = dom.volumeLongTermZigInput.value;
            const volumeZigPhaseSource = dom.volumeZigPhaseSourceSelect.value;
            
            const apiUrl = `/api/stock_data?ticker=${ticker}&period=${period}` +
                         `&price_std=${priceStd}&volume_std=${volumeStd}` +
                         `&price_only_std=${priceOnlyStd}&volume_only_std=${volumeOnlyStd}` +
                         `&short_term_zig=${shortTermZig}&medium_term_zig=${mediumTermZig}` +
                         `&long_term_zig=${longTermZig}&zig_phase_source=${zigPhaseSource}` +
                         `&volume_short_term_zig=${volumeShortTermZig}` +
                         `&volume_medium_term_zig=${volumeMediumTermZig}` +
                         `&volume_long_term_zig=${volumeLongTermZig}` +
                         `&volume_zig_phase_source=${volumeZigPhaseSource}`;

            try {
                const response = await fetch(apiUrl);
                if (!response.ok) {
                    const errorData = await response.json();
                    throw new Error(errorData.error || `HTTP 错误: ${response.status}`);
                }
                
                const data = await response.json();
                console.log('[DEBUG] 完整API响应数据:', data);
                console.log('[DEBUG] company_name字段值:', data.company_name);
                
                if (!data.data || data.data.length === 0) {
                    throw new Error('处理后无有效数据');
                }

                const stockData = data.data.map(d => ({
                    date: d[0],
                    open: d[1],
                    close: d[2],
                    low: d[3],
                    high: d[4],
                    volume: d[5],
                    changePct: d[6] // V1.3: 涨跌幅
                }));
                
                const annotations = data.annotations || [];
                const marketPhases = data.market_phases || [];
                const companyName = data.company_name; // 获取公司名称
                console.log('[DEBUG] 从API获取的companyName:', companyName);
                
                // V1.9: 获取ZIG数据
                const zig5 = data.zig5 || [];
                const zig25 = data.zig25 || [];
                const zig50 = data.zig50 || [];

                // V2.0: 获取成交量ZIG数据
                const volume_zig5 = data.volume_zig5 || [];
                const volume_zig25 = data.volume_zig25 || [];
                const volume_zig50 = data.volume_zig50 || [];
                const volume_phases = data.volume_phases || [];
                
                // 新增：获取常用均线数据
                const ma5_new = data.ma5_new || [];
                const ma20 = data.ma20 || [];
                const ma60_new = data.ma60_new || [];
                
                // V2.2: 将获取的数据存入全局变量
                currentChartData = {
                    ticker,
                    companyName,
                    stockData,
                    annotations: annotations,
                    marketPhases,
                    zig5,
                    zig25,
                    zig50,
                    volume_zig5,
                    volume_zig25,
                    volume_zig50,
                    volume_phases,
                    // 新增：常用均线数据
                    ma5_new,
                    ma20,
                    ma60_new
                };
                
                dom.statusDiv.textContent = `成功获取 ${ticker} 的 ${stockData.length} 条数据，发现 ${annotations.length} 个异常点。`;
                
                renderChart(); // 使用全局数据渲染
                updateAnnotationList();
                updateUndoRedoButtons();

            } catch (error) {
                console.error('获取或处理数据时出错:', error);
                // 处理多行错误信息，将换行符转换为<br>标签
                const errorMessage = error.message.replace(/\n/g, '<br>');
                dom.statusDiv.innerHTML = `<div class="error">❌ 获取数据失败:<br><br>${errorMessage}</div>`;
                if(myChart) myChart.clear(); // 获取失败时清空图表
            }
        }

        // 检测注释内容是否已经是标准化格式
        function isStandardizedAnnotationFormat(text) {
            if (!text || typeof text !== 'string') return false;
            
            // 标准格式应该包含：
            // 1. 公司名称 + 股票代码 + "股价异动时点："
            // 2. 日期
            // 3. "股价波动" + 数字 + "%"
            
            const standardFormatPattern = /^.+\s+\w+\s+股价异动时点：\d{4}-\d{2}-\d{2}\n股价波动[+\-]?\d+\.?\d*%/;
            const isStandard = standardFormatPattern.test(text.trim());
            
            // 调试日志
            if (isStandard) {
                console.log('[格式检测] 识别为标准化格式:', text.substring(0, 50) + '...');
            } else {
                console.log('[格式检测] 非标准化格式:', text.substring(0, 50) + '...');
            }
            
            return isStandard;
        }

        // 基于现有图表数据计算股价涨跌幅（复用注释圆点边框颜色的成熟逻辑）
        function getStockChangeFromChart(date) {
            if (!myChart || !currentChartData) {
                console.log('[涨跌幅计算] 图表数据不可用');
                return null;
            }
            
            try {
                const chartOption = myChart.getOption();
                if (!chartOption || !chartOption.xAxis || !chartOption.xAxis[0].data) {
                    console.log('[涨跌幅计算] 图表配置不完整');
                    return null;
                }
                
                const allDates = chartOption.xAxis[0].data;
                const dataIndex = allDates.indexOf(date);
                
                console.log(`[涨跌幅计算] 查找日期 ${date}, 索引: ${dataIndex}, 总数据: ${allDates.length}`);
                
                if (dataIndex <= 0 || dataIndex >= chartOption.series[0].data.length) {
                    console.log('[涨跌幅计算] 无法找到有效的数据索引或无前日数据');
                    return null;
                }
                
                // 复用现有的成熟逻辑（与注释圆点边框颜色计算完全相同）
                const currentKlineData = chartOption.series[0].data[dataIndex];
                const prevKlineData = chartOption.series[0].data[dataIndex - 1];
                
                if (!currentKlineData || !prevKlineData || !currentKlineData.value || !prevKlineData.value) {
                    console.log('[涨跌幅计算] K线数据格式异常');
                    return null;
                }
                
                const closePrice = currentKlineData.value[1]; // 当日收盘价
                const prevClosePrice = prevKlineData.value[1]; // 前日收盘价
                
                if (typeof closePrice !== 'number' || typeof prevClosePrice !== 'number' || prevClosePrice === 0) {
                    console.log('[涨跌幅计算] 价格数据异常', { closePrice, prevClosePrice });
                    return null;
                }
                
                // 计算涨跌幅百分比
                const changePercent = ((closePrice - prevClosePrice) / prevClosePrice * 100);
                const formattedChange = changePercent.toFixed(2);
                
                const result = {
                    changePercent: parseFloat(formattedChange),
                    changeText: `股价波动${changePercent > 0 ? '+' : ''}${formattedChange}%`,
                    closePrice: closePrice,
                    prevClosePrice: prevClosePrice,
                    direction: closePrice > prevClosePrice ? 'up' : (closePrice < prevClosePrice ? 'down' : 'flat')
                };
                
                console.log(`[涨跌幅计算] 计算成功:`, result);
                return result;
                
            } catch (error) {
                console.error('[涨跌幅计算] 计算失败:', error);
                return null;
            }
        }

        // 获取特定日期的股价数据，用于自动填充注释内容
        async function fetchStockDataForDate(ticker, date) {
            try {
                console.log(`[DEBUG] 获取 ${ticker} 在 ${date} 的股价数据`);
                
                const response = await fetch(`/api/stock_data/${ticker}/${date}`);
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
                }
                
                const data = await response.json();
                if (!data.success) {
                    throw new Error(data.error || '获取股价数据失败');
                }
                
                return data;
                
            } catch (error) {
                console.error(`[ERROR] 获取 ${ticker} 在 ${date} 的股价数据失败:`, error);
                return null;
            }
        }

        // V2.2: renderChart不再接收大量参数，而是从全局变量获取
        function renderChart() {
            if (!myChart || !currentChartData) return;

            const {
                ticker, companyName, stockData, annotations, marketPhases,
                zig5, zig25, zig50,
                volume_zig5, volume_zig25, volume_zig50, volume_phases,
                ma5_new, ma20, ma60_new
            } = currentChartData;

            console.log('[DEBUG] renderChart - ticker:', ticker);
            console.log('[DEBUG] renderChart - companyName:', companyName);
            console.log('[DEBUG] renderChart - 图表标题将显示:', companyName || ticker);

            // V2.4 调试: 打印ZIG数据以检查内容
            console.log("Price ZIG(5) Data:", zig5);
            console.log("Volume ZIG(5) Data:", volume_zig5);
            
            // V2.6 调试: 检查DOM元素和复选框状态
            console.log("ZIG复选框状态:", {
                shortTerm: dom.shortTermZigCheck ? dom.shortTermZigCheck.checked : 'DOM元素未找到',
                mediumTerm: dom.mediumTermZigCheck ? dom.mediumTermZigCheck.checked : 'DOM元素未找到',
                longTerm: dom.longTermZigCheck ? dom.longTermZigCheck.checked : 'DOM元素未找到'
            });

            // 保持原始注释ID，不覆盖数据库中的真实ID
            currentAnnotations = [...annotations];
            
            // 调试：验证AI分析数据加载
            const aiAnalysisAnnotations = annotations.filter(anno => 
                anno.algorithm_type === 'ai_analysis'
            );
            
            if (aiAnalysisAnnotations.length > 0) {
                console.log(`[数据加载] 发现 ${aiAnalysisAnnotations.length} 条AI分析注释:`);
                aiAnalysisAnnotations.forEach(anno => {
                    console.log(`[AI注释] ${anno.id}: 长度=${anno.text.length}, 类型=${anno.algorithm_type}, 日期=${anno.date}`);
                });
            } else {
                console.log('[数据加载] 未发现AI分析注释');
            }
            
            const dates = stockData.map(item => item.date);
            const klineData = stockData.map(item => ({
                name: item.date,
                value: [item.open, item.close, item.low, item.high]
            }));
            const volumes = stockData.map((item, index) => [index, item.volume, item.close > item.open ? 1 : -1]);
            
            // --- 阶段划分与颜色处理 ---
            // V2.9: 使用用户指定的背景底色
            const phaseColors = { 'Uptrend': '#fbebe9', 'Downtrend': '#edf9ef' };
            const markAreaPieces = marketPhases.map(phase => ([
                { name: phase.phase, xAxis: phase.start_date, itemStyle: { color: phaseColors[phase.phase] } },
                { xAxis: phase.end_date }
            ]));
            
            // V2.7 调试：检查背景底色图数据
            console.log("Market phases数量:", marketPhases.length);
            console.log("MarkArea pieces数量:", markAreaPieces.length);
            if (markAreaPieces.length > 0) {
                console.log("第一个markArea piece:", markAreaPieces[0]);
            }

            // V2.4: 根据用户反馈再次对调颜色
            const volumePhaseColors = { 'Uptrend': 'rgba(255, 182, 193, 0.7)', 'Downtrend': 'rgba(144, 238, 144, 0.7)' };
            const volumeDateMap = {};
            volume_phases.forEach(phase => {
                let currentDate = new Date(phase.start_date);
                const endDate = new Date(phase.end_date);
                while(currentDate <= endDate) {
                    volumeDateMap[currentDate.toISOString().split('T')[0]] = volumePhaseColors[phase.phase];
                    currentDate.setDate(currentDate.getDate() + 1);
                }
            });

            // V2.9: 更新图例，使用正确的均线名称
            const legendData = ['K线', '成交量', 'MA5', 'MA20', 'MA60'];

            const option = {
                animation: false, // 禁用动画以提高性能
                title: { text: `${companyName || ticker} 股价K线图`, left: 'center' },
                tooltip: {
                    trigger: 'axis',  // V5.3: 保留十字光标但隐藏提示内容
                    axisPointer: { 
                        type: 'cross'
                    },
                    formatter: function() {
                        return '';  // 返回空字符串，不显示任何提示内容
                    },
                    backgroundColor: 'transparent',  // 透明背景
                    borderWidth: 0,  // 无边框
                    textStyle: {
                        color: 'transparent'  // 透明文字（双重保险）
                    }
                },
                legend: { data: legendData, bottom: 10 },
                grid: [ { left: '8%', right: '2%', height: '50%', top: '15%' }, { left: '8%', right: '2%', top: '70%', height: '20%' } ],
                xAxis: [ { type: 'category', data: dates, scale: true }, { type: 'category', gridIndex: 1, data: dates, scale: true } ],
                yAxis: [ { scale: true }, { scale: true, gridIndex: 1 } ],
                dataZoom: [ 
                    { type: 'inside', xAxisIndex: [0, 1] }, 
                    { show: true, xAxisIndex: [0, 1], type: 'slider', top: '90%', brushSelect: false } 
                ],
                series: [
                    { 
                        name: 'K线', 
                        type: 'candlestick', 
                        data: klineData,
                        markArea: {
                            itemStyle: {
                                opacity: 0.8  // V2.8 调整：恢复淡雅的背景底色图效果
                            },
                            emphasis: {
                                disabled: true  // V2.10 修复：禁用鼠标悬停时的强调效果，防止背景底色消失
                            },
                            data: markAreaPieces,
                            label: {
                                show: false, // V1.3: 禁用MarkArea的文字标签
                            }
                        }
                    },
                    {
                        name: '成交量',
                        type: 'bar',
                        xAxisIndex: 1,
                        yAxisIndex: 1,
                        data: volumes,
                        itemStyle: {
                            color: function(params) {
                                // V2.0: 根据成交量阶段设置颜色
                                const date = dates[params.dataIndex];
                                if (volumeDateMap[date]) {
                                    return volumeDateMap[date];
                                }
                                // 默认颜色
                                var color = params.data[2] > 0 ? '#ee4949' : '#3ee391';
                                return color;
                            }
                        }
                    },
                    // V2.9: 使用用户指定的均线配置和颜色
                    {
                        name: 'MA5',
                        type: 'line',
                        xAxisIndex: 0,
                        yAxisIndex: 0,
                        data: ma5_new,
                        smooth: true,
                        lineStyle: { width: 2, color: '#8B4513' }, // 棕色
                        symbol: 'none'
                    },
                    {
                        name: 'MA20',
                        type: 'line',
                        xAxisIndex: 0,
                        yAxisIndex: 0,
                        data: ma20,
                        smooth: true,
                        lineStyle: { width: 2, color: '#FFD700' }, // 黄色
                        symbol: 'none'
                    },
                    {
                        name: 'MA60',
                        type: 'line',
                        xAxisIndex: 0,
                        yAxisIndex: 0,
                        data: ma60_new,
                        smooth: true,
                        lineStyle: { width: 2, color: '#008000' }, // 绿色
                        symbol: 'none'
                    },
                    // V2.5: 价格ZIG线 (根据复选框显示)
                    dom.shortTermZigCheck && dom.shortTermZigCheck.checked && {
                        name: 'ZIG(5)',
                        type: 'line',
                        xAxisIndex: 0, // V2.5: 显式指定
                        yAxisIndex: 0, // V2.5: 显式指定
                        data: zig5,
                        smooth: false,
                        symbol: 'circle', symbolSize: 8,
                        lineStyle: { width: 2, type: 'solid', color: '#E87A90' }
                    },
                    dom.mediumTermZigCheck && dom.mediumTermZigCheck.checked && {
                        name: 'ZIG(25)',
                        type: 'line',
                        xAxisIndex: 0, // V2.5: 显式指定
                        yAxisIndex: 0, // V2.5: 显式指定
                        data: zig25,
                        smooth: false,
                        symbol: 'circle', symbolSize: 8,
                        lineStyle: { width: 2, type: 'solid', color: '#73C9E6' }
                    },
                    dom.longTermZigCheck && dom.longTermZigCheck.checked && {
                        name: 'ZIG(50)',
                        type: 'line',
                        xAxisIndex: 0, // V2.5: 显式指定
                        yAxisIndex: 0, // V2.5: 显式指定
                        data: zig50,
                        smooth: false,
                        symbol: 'circle', symbolSize: 8,
                        lineStyle: { width: 2, type: 'solid', color: '#FFC64B' }
                    },
                    // V2.0: 成交量ZIG线 (根据复选框显示)
                    dom.volumeShortTermZigCheck && dom.volumeShortTermZigCheck.checked && {
                        name: 'Volume ZIG(5)',
                        type: 'line',
                        xAxisIndex: 1,
                        yAxisIndex: 1,
                        data: volume_zig5,
                        smooth: false,
                        symbol: 'triangle', symbolSize: 6,
                        lineStyle: { width: 1, type: 'dashed', color: '#E87A90' }
                    },
                    dom.volumeMediumTermZigCheck && dom.volumeMediumTermZigCheck.checked && {
                        name: 'Volume ZIG(25)',
                        type: 'line',
                        xAxisIndex: 1,
                        yAxisIndex: 1,
                        data: volume_zig25,
                        smooth: false,
                        symbol: 'triangle', symbolSize: 6,
                        lineStyle: { width: 1, type: 'dashed', color: '#73C9E6' }
                    },
                    dom.volumeLongTermZigCheck && dom.volumeLongTermZigCheck.checked && {
                        name: 'Volume ZIG(50)',
                        type: 'line',
                        xAxisIndex: 1,
                        yAxisIndex: 1,
                        data: volume_zig50,
                        smooth: false,
                        symbol: 'triangle', symbolSize: 6,
                        lineStyle: { width: 1, type: 'dashed', color: '#FFC64B' }
                    }
                ].filter(Boolean)
            };
            
            // V2.6 调试: 检查最终的series配置
            console.log("最终series配置:", option.series.map(s => s.name));
            console.log("ZIG series数据长度:", {
                zig5: option.series.find(s => s.name === 'ZIG(5)') ? zig5.length : '未找到',
                zig25: option.series.find(s => s.name === 'ZIG(25)') ? zig25.length : '未找到', 
                zig50: option.series.find(s => s.name === 'ZIG(50)') ? zig50.length : '未找到'
            });
            
            myChart.setOption(option, { notMerge: true });
            
            // V5.3: 重置十字光标状态（图表更新后）
            crosshairPosition.isActive = false;
            crosshairPosition.dataIndex = -1;
            
            // V1.3: 渲染自定义图例
            renderChartLegend(phaseColors);

            myChart.off('datazoom').on('datazoom', renderCustomAnnotations);
            myChart.off('resize').on('resize', renderCustomAnnotations);
            
            renderCustomAnnotations();
            updateAnnotationList();
            
            // 恢复正在进行的AI分析动画状态
            globalAIAnalysisState.restoreAllAnimations();
        }

        // --- 时间跨度计算函数（仅用于手动注释的小图标判断） ---
        function calculateDisplayTimeSpan() {
            if (!myChart) return 0;
            
            const chartOption = myChart.getOption();
            if (!chartOption || !chartOption.xAxis || !chartOption.xAxis[0].data || !chartOption.dataZoom) return 0;
            
            const allDates = chartOption.xAxis[0].data;
            const dataZoom = chartOption.dataZoom[0];
            
            if (!dataZoom || dataZoom.start === undefined || dataZoom.end === undefined) return 0;
            
            // 计算显示范围比例
            const visibleRange = (dataZoom.end - dataZoom.start) / 100;
            
            // 计算总时间跨度
            const firstDate = new Date(allDates[0]);
            const lastDate = new Date(allDates[allDates.length - 1]);
            const totalTimeSpanMs = lastDate.getTime() - firstDate.getTime();
            const totalTimeSpanDays = totalTimeSpanMs / (1000 * 60 * 60 * 24);
            
            // 计算实际显示的时间跨度
            const displayTimeSpanDays = totalTimeSpanDays * visibleRange;
            
            return displayTimeSpanDays;
        }
        
        // --- 判断是否应该为注释显示小图标 ---
        function shouldShowSmallIcon() {
            const timeSpanDays = calculateDisplayTimeSpan();
            return timeSpanDays > styleSettings.timeSpanThreshold; // 超过设定阈值显示小图标
        }

        function renderCustomAnnotations() {
            if (!myChart || !dom.infoBoxContainer) return;
            dom.infoBoxContainer.innerHTML = '';
            
            const svgLayer = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            svgLayer.setAttribute('class', 'annotation-svg');
            dom.infoBoxContainer.appendChild(svgLayer);
            
            const chartOption = myChart.getOption();
            if (!chartOption || !chartOption.xAxis || !chartOption.xAxis[0].data) return;
            
            const allDates = chartOption.xAxis[0].data;
            const dataZoom = chartOption.dataZoom[0];
            const startIndex = Math.floor(allDates.length * (dataZoom.start / 100));
            const endIndex = Math.ceil(allDates.length * (dataZoom.end / 100));

            // V1.8: 根据复选框状态过滤注释
            const enabledAnnotationTypes = new Set();
            if (dom.priceVolumeCheck.checked) enabledAnnotationTypes.add('price_volume');
            if (dom.volumePriceCheck.checked) enabledAnnotationTypes.add('volume_stable_price');
            if (dom.priceOnlyCheck.checked) enabledAnnotationTypes.add('price_only');
            if (dom.volumeOnlyCheck.checked) enabledAnnotationTypes.add('volume_only');

            const visibleAnnotations = currentAnnotations.filter(anno =>
                enabledAnnotationTypes.has(anno.type) ||
                anno.type === 'manual' || // 手动添加的注释始终显示
                anno.algorithm_type === 'ai_analysis' // AI分析注释始终显示（修复：检查algorithm_type）
            );

            visibleAnnotations.forEach(anno => {
                let dataIndex = allDates.indexOf(anno.date);
                
                // V3.2: 对于手动注释，如果精确日期不存在，则寻找最接近的日期
                if (dataIndex === -1 && anno.type === 'manual') {
                    const annoDate = new Date(anno.date);
                    let closestIndex = -1;
                    let minDistance = Infinity;
                    
                    allDates.forEach((date, index) => {
                        const currentDate = new Date(date);
                        const distance = Math.abs(currentDate - annoDate);
                        if (distance < minDistance) {
                            minDistance = distance;
                            closestIndex = index;
                        }
                    });
                    
                    dataIndex = closestIndex;
                }
                
                // 如果还是找不到合适的位置，跳过这个注释
                if (dataIndex === -1 || dataIndex < startIndex || dataIndex > endIndex) return;

                const klineData = chartOption.series[0].data[dataIndex];
                if (!klineData) return;

                // V1.7 修正：从结构化数据中安全地获取最高价
                const highPoint = klineData.value[3];
                const pixel = myChart.convertToPixel({ gridIndex: 0 }, [dataIndex, highPoint]);
                if (!pixel) return;

                const [px, py] = pixel;
                
                const annoBox = document.createElement('div');
                annoBox.dataset.annotationId = anno.id; // 添加数据属性用于状态管理
                
                // 判断是否应该显示小图标（适用于所有注释类型）
                const shouldUseSmallIcon = shouldShowSmallIcon();
                
                if (shouldUseSmallIcon) {
                    annoBox.className = 'annotation-icon';
                } else {
                    annoBox.className = 'annotation-box';
                }

                // 尝试从localStorage加载保存的位置信息
                const savedPosition = getSavedAnnotationPosition(currentTicker, anno.date, anno.text);
                
                if (shouldUseSmallIcon) {
                    // 小图标模式：固定尺寸
                    annoBox.style.width = '20px';
                    annoBox.style.height = '20px';
                    // 移除原有的title悬停提示，使用新的悬停预览功能
                } else {
                    // 完整注释框模式：使用原有的尺寸逻辑
                    if (savedPosition && savedPosition.width && savedPosition.height) {
                        annoBox.style.width = savedPosition.width;
                        annoBox.style.height = savedPosition.height;
                        // 同步到内存中的anno对象
                        anno.userWidth = savedPosition.width;
                        anno.userHeight = savedPosition.height;
                    } else if (anno.userWidth && anno.userHeight) {
                        annoBox.style.width = anno.userWidth;
                        annoBox.style.height = anno.userHeight;
                    } else {
                        annoBox.style.width = '160px';
                        annoBox.style.height = '60px';
                    }
                }

                // 计算标准的默认位置（始终在K线柱上方）
                const currentBoxWidth = parseInt(annoBox.style.width);
                const currentBoxHeight = parseInt(annoBox.style.height);
                const defaultLeft = px - (currentBoxWidth / 2); // 注释框默认居中于K线柱上方
                const defaultTop = py - currentBoxHeight - 10; // 注释框默认位于K线柱上方，并留出10px间距

                // 设置位置 - 股价坐标系自适应位置系统
                let finalLeft = defaultLeft;
                let finalTop = defaultTop;
                let hasCustomPosition = false;

                if (savedPosition) {
                    if (savedPosition.positionType === 'price_based' && savedPosition.priceOffset !== undefined && savedPosition.timeOffset !== undefined) {
                        // 最新方式：使用股价坐标系计算位置
                        const currentKlinePrice = klineData.value[1]; // 收盘价
                        
                        // 计算目标股价和时间位置
                        const targetPrice = currentKlinePrice + savedPosition.priceOffset;
                        const targetTimeIndex = dataIndex + savedPosition.timeOffset;
                        
                        // 将股价坐标转换为像素坐标
                        const targetPixel = myChart.convertToPixel({ gridIndex: 0 }, [targetTimeIndex, targetPrice]);
                        
                        if (targetPixel && targetPixel.length >= 2) {
                            // 计算注释框左上角位置
                            const calculatedLeft = targetPixel[0] - currentBoxWidth / 2;
                            const calculatedTop = targetPixel[1] - currentBoxHeight / 2;
                            
                            // 边界检测：确保注释框在可视区域内
                            const chartContainer = dom.chartContainer.getBoundingClientRect();
                            const minLeft = 0;
                            const maxLeft = chartContainer.width - currentBoxWidth;
                            const minTop = 0;
                            const maxTop = chartContainer.height - currentBoxHeight;
                            
                            // 应用边界限制
                            const boundedLeft = Math.max(minLeft, Math.min(maxLeft, calculatedLeft));
                            const boundedTop = Math.max(minTop, Math.min(maxTop, calculatedTop));
                            
                            // 检查股价偏移是否合理（股价偏移超过基础价格的50%被认为过大）
                            const priceOffsetRatio = Math.abs(savedPosition.priceOffset) / Math.abs(currentKlinePrice);
                            
                            if (priceOffsetRatio <= 0.5) {
                                // 股价偏移合理，使用计算出的位置
                                finalLeft = boundedLeft;
                                finalTop = boundedTop;
                                hasCustomPosition = true;
                            } else {
                                // 股价偏移过大，使用默认位置
                                console.log(`股价偏移过大(${(priceOffsetRatio*100).toFixed(1)}%)，使用默认位置:`, anno.text);
                            }
                        } else {
                            console.log(`股价坐标转换失败，使用默认位置:`, anno.text);
                        }
                        
                    } else if (savedPosition.positionType === 'relative' && savedPosition.offsetX !== undefined && savedPosition.offsetY !== undefined) {
                        // 向后兼容：使用像素偏移计算位置
                        const boxCenterX = px + savedPosition.offsetX;
                        const boxCenterY = py + savedPosition.offsetY;
                        
                        const calculatedLeft = boxCenterX - currentBoxWidth / 2;
                        const calculatedTop = boxCenterY - currentBoxHeight / 2;
                        
                        // 边界检测
                        const chartContainer = dom.chartContainer.getBoundingClientRect();
                        const boundedLeft = Math.max(0, Math.min(chartContainer.width - currentBoxWidth, calculatedLeft));
                        const boundedTop = Math.max(0, Math.min(chartContainer.height - currentBoxHeight, calculatedTop));
                        
                        // 距离检查
                        const distance = Math.sqrt(Math.pow(boundedLeft + currentBoxWidth/2 - px, 2) + Math.pow(boundedTop + currentBoxHeight/2 - py, 2));
                        
                        if (distance <= 200) {
                            finalLeft = boundedLeft;
                            finalTop = boundedTop;
                            hasCustomPosition = true;
                        }
                        
                    } else if (savedPosition.positionType === 'absolute' && savedPosition.left && savedPosition.top) {
                        // 向后兼容：使用旧的绝对位置
                        finalLeft = parseInt(savedPosition.left);
                        finalTop = parseInt(savedPosition.top);
                        hasCustomPosition = true;
                    }
                }

                // 应用最终位置
                annoBox.style.left = `${finalLeft}px`;
                annoBox.style.top = `${finalTop}px`;

                // 更新内存中的anno对象
                if (hasCustomPosition) {
                    anno.userLeft = `${finalLeft}px`;
                    anno.userTop = `${finalTop}px`;
                    anno.hasUserPosition = true;
                } else {
                    delete anno.userLeft;
                    delete anno.userTop;
                    delete anno.hasUserPosition;
                }
                
                annoBox.style.backgroundColor = styleSettings.bgColor;
                annoBox.style.opacity = styleSettings.opacity;
                annoBox.style.pointerEvents = 'all'; // 确保可交互
                
                // V5.3: 根据真实涨跌情况设置边框颜色（基于前日收盘价比较）
                const closePrice = klineData.value[1]; // 当日收盘价
                let borderColor;
                
                if (dataIndex > 0) {
                    // 获取前一日的K线数据进行比较
                    const prevKlineData = chartOption.series[0].data[dataIndex - 1];
                    const prevClosePrice = prevKlineData.value[1]; // 前日收盘价
                    
                    if (closePrice > prevClosePrice) {
                        // 真正上涨（收盘价高于前日收盘价）：红色边框
                        borderColor = '#ff0000';
                    } else if (closePrice < prevClosePrice) {
                        // 真正下跌（收盘价低于前日收盘价）：绿色边框
                        borderColor = '#00aa00';
                    } else {
                        // 平盘（收盘价等于前日收盘价）：绿色边框
                        borderColor = '#00aa00';
                    }
                } else {
                    // 第一个交易日，无前日数据可比较，使用默认绿色
                    borderColor = '#00aa00';
                }
                
                annoBox.style.border = '2px solid ' + borderColor;
                
                // 将边框颜色信息保存到注释对象中，供弹窗使用
                anno.borderColor = borderColor;
                
                if (shouldUseSmallIcon) {
                    // 小图标模式：根据是否为重点注释显示实心或空心圆点
                    const isFavorite = anno.is_favorite;
                    const iconClass = isFavorite ? 'icon-content favorite' : 'icon-content';
                    annoBox.innerHTML = `<div class="${iconClass}"></div>`;
                    
                    // 根据注释内容长度控制外层圆圈显示
                    const contentLength = (anno.text || '').length;
                    if (contentLength < styleSettings.contentThreshold) {
                        annoBox.classList.add('content-insufficient');
                    } else {
                        annoBox.classList.remove('content-insufficient');
                    }
                    
                    // 如果是重点注释，设置与边框相同的颜色
                    if (isFavorite && borderColor) {
                        annoBox.style.setProperty('--favorite-color', borderColor);
                    }
                    
                    // 为小图标添加双击事件显示注释内容弹窗
                    annoBox.addEventListener('dblclick', (e) => {
                        e.stopPropagation();
                        showAnnotationPopup(anno, e.clientX, e.clientY);
                    });
                    
                    // 为小图标添加右键菜单
                    annoBox.addEventListener('contextmenu', (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        showAnnotationContextMenu(anno, e.clientX, e.clientY);
                    });
                    
                    // 为小图标添加悬停预览功能
                    annoBox.addEventListener('mouseenter', (e) => {
                        // 清除之前的超时
                        if (hoverTimeout) {
                            clearTimeout(hoverTimeout);
                        }
                        if (hideTimeout) {
                            clearTimeout(hideTimeout);
                            hideTimeout = null;
                        }
                        // 延迟显示，避免误触发
                        hoverTimeout = setTimeout(() => {
                            showHoverPreview(anno, e.clientX, e.clientY);
                        }, 300);
                    });
                    
                    annoBox.addEventListener('mouseleave', () => {
                        // 清除显示超时
                        if (hoverTimeout) {
                            clearTimeout(hoverTimeout);
                            hoverTimeout = null;
                        }
                        // 如果当前有活跃的弹窗，不隐藏悬停预览（避免干扰）
                        if (activePopupAnnotation && activePopupAnnotation.id === anno.id) {
                            return;
                        }
                        // 延迟隐藏，给用户时间移动到弹窗上
                        hideTimeout = setTimeout(() => {
                            if (currentHoverPopup) {
                                currentHoverPopup.remove();
                                currentHoverPopup = null;
                            }
                        }, 200);
                    });
                } else {
                    // 完整注释框模式：使用原有的显示逻辑
                    // V3.2: 为跨周期显示的手动注释添加标识
                    let displayText = `${anno.date}\n${anno.text}`;
                    let titleSuffix = '';
                    if (anno.type === 'manual' && allDates.indexOf(anno.date) === -1) {
                        // 这是一个跨周期显示的注释
                        const actualDisplayDate = allDates[dataIndex];
                        titleSuffix = ` (原日期: ${anno.date}, 显示在: ${actualDisplayDate})`;
                        displayText = `${anno.date} [跨周期]\n${anno.text}`;
                    }
                    
                    // 为所有注释添加编辑按钮
                    annoBox.innerHTML = `
                        <div class="annotation-content">
                            <div class="annotation-text" style="color: ${styleSettings.textColor}; font-size: ${styleSettings.fontSize}px; white-space: pre-line;" title="注释详情${titleSuffix}">${displayText}</div>
                            <button class="annotation-edit" data-id="${anno.id}">✎</button>
                            <button class="annotation-close" data-id="${anno.id}">×</button>
                        </div>
                        <div class="resize-handle">⌟</div>
                    `;
                }
                dom.infoBoxContainer.appendChild(annoBox);
                
                const arrowEl = document.createElementNS('http://www.w3.org/2000/svg', 'g');
                arrowEl.innerHTML = `<line class="annotation-arrow-line" stroke="${styleSettings.lineColor}" stroke-width="2" fill="none"></line><polygon class="annotation-arrow-head" fill="${styleSettings.lineColor}" stroke="${styleSettings.lineColor}" stroke-width="1"></polygon>`;
                svgLayer.appendChild(arrowEl);
                const line = arrowEl.querySelector('.annotation-arrow-line');
                const head = arrowEl.querySelector('.annotation-arrow-head');

                const updateArrow = () => {
                    const endPoint = getArrowEndPoint(px, py, annoBox);
                    line.setAttribute('x1', String(px));
                    line.setAttribute('y1', String(py));
                    line.setAttribute('x2', String(endPoint.x));
                    line.setAttribute('y2', String(endPoint.y));
                    head.setAttribute('points', getArrowHeadPoints(px, py, endPoint.x, endPoint.y));
                };

                updateArrow();
                
                setupAnnotationInteraction(annoBox, anno, updateArrow, px, py, klineData, dataIndex);
            });
            
            // 恢复正在进行的AI分析动画状态（DOM重建后）
            globalAIAnalysisState.restoreAllAnimations();
        }
        
        // --- Helper functions for drawing ---
        function getArrowEndPoint(startX, startY, boxEl) {
            const box = {
                x: boxEl.offsetLeft,
                y: boxEl.offsetTop,
                width: boxEl.offsetWidth,
                height: boxEl.offsetHeight,
            };
            const boxCenterX = box.x + box.width / 2;
            const boxCenterY = box.y + box.height / 2;
            const dx = startX - boxCenterX;
            const dy = startY - boxCenterY;

            let endX, endY;
            if (dx === 0 && dy === 0) return { x: box.x, y: boxCenterY };

            const ratio = Math.abs(dx / box.width) > Math.abs(dy / box.height) ? 
                Math.abs(box.width / 2 / dx) : 
                Math.abs(box.height / 2 / dy);

            endX = boxCenterX + dx * ratio;
            endY = boxCenterY + dy * ratio;
            
            return {x: endX, y: endY};
        }

        function getArrowHeadPoints(startX, startY, endX, endY, size = 8) {
            // Corrected angle: from the box (end) to the k-line (start), arrowhead at start
            const angle = Math.atan2(startY - endY, startX - endX);
            const p1x = startX - size * Math.cos(angle - Math.PI / 6);
            const p1y = startY - size * Math.sin(angle - Math.PI / 6);
            const p2x = startX - size * Math.cos(angle + Math.PI / 6);
            const p2y = startY - size * Math.sin(angle + Math.PI / 6);
            return `${startX},${startY} ${p1x},${p1y} ${p2x},${p2y}`;
        }

        // --- 注释管理与交互 ---
        function setupAnnotationInteraction(annoBox, anno, updateArrow, klinePx, klinePy, klineData, dataIndex) {
            const closeBtn = annoBox.querySelector('.annotation-close');
            const editBtn = annoBox.querySelector('.annotation-edit');
            
            if(closeBtn) {
                closeBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    removeAnnotation(anno.id);
                });
            }
            
            if(editBtn) {
                editBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    showEditAnnotationDialog(anno);
                });
            }

            let isDragging = false;
            let offsetX, offsetY;

            annoBox.addEventListener('mousedown', (e) => {
                if (e.target.tagName === 'BUTTON' || e.target.classList.contains('resize-handle')) {
                    return;
                }
                
                // 只有左键点击才启动拖拽，避免右键菜单时误触发
                if (e.button !== 0) {
                    return;
                }
                
                isDragging = true;
                annoBox.style.cursor = 'grabbing';
                annoBox.style.zIndex = 20;

                const boxRect = annoBox.getBoundingClientRect();
                offsetX = e.clientX - boxRect.left;
                offsetY = e.clientY - boxRect.top;
                
                const parentRect = dom.infoBoxContainer.getBoundingClientRect();

                function onMouseMove(e) {
                    if (!isDragging) return;
                    
                    let newX = e.clientX - parentRect.left - offsetX;
                    let newY = e.clientY - parentRect.top - offsetY;

                    // Constrain within the container bounds
                    newX = Math.max(0, Math.min(newX, parentRect.width - boxRect.width));
                    newY = Math.max(0, Math.min(newY, parentRect.height - boxRect.height));

                    annoBox.style.left = `${newX}px`;
                    annoBox.style.top = `${newY}px`;
                    
                    if (updateArrow) {
                        updateArrow();
                    }
                }

                function onMouseUp() {
                    isDragging = false;
                    annoBox.style.cursor = 'grab';
                    annoBox.style.zIndex = 10;
                    document.removeEventListener('mousemove', onMouseMove);
                    document.removeEventListener('mouseup', onMouseUp);

                    // Save the new position to the annotation object
                    anno.userLeft = annoBox.style.left;
                    anno.userTop = annoBox.style.top;
                    
                    // 实时保存位置到localStorage（使用股价坐标系）
                    const klinePrice = klineData.value[1]; // 收盘价
                    saveAnnotationPosition(currentTicker, anno.date, anno.text, {
                        left: annoBox.style.left,
                        top: annoBox.style.top,
                        width: annoBox.style.width,
                        height: annoBox.style.height
                    }, {
                        pixel: {x: klinePx, y: klinePy},
                        price: klinePrice,
                        dateIndex: dataIndex
                    }); // 传递完整K线数据用于股价坐标系计算
                }

                document.addEventListener('mousemove', onMouseMove);
                document.addEventListener('mouseup', onMouseUp);
            });

            // --- Resizing Logic ---
            const resizeHandle = annoBox.querySelector('.resize-handle');
            if (resizeHandle) {
                resizeHandle.addEventListener('mousedown', (e) => {
                    e.stopPropagation();
                    const startWidth = annoBox.offsetWidth;
                    const startHeight = annoBox.offsetHeight;
                    const startX = e.clientX;
                    const startY = e.clientY;

                    const onResizeMouseMove = (moveEvent) => {
                        const dx = moveEvent.clientX - startX;
                        const dy = moveEvent.clientY - startY;
                        
                        const newWidth = Math.max(100, startWidth + dx);
                        const newHeight = Math.max(40, startHeight + dy);

                        annoBox.style.width = `${newWidth}px`;
                        annoBox.style.height = `${newHeight}px`;

                        if(updateArrow) updateArrow();
                    };

                    const onResizeMouseUp = () => {
                        document.removeEventListener('mousemove', onResizeMouseMove);
                        document.removeEventListener('mouseup', onResizeMouseUp);
                        // Persist new size
                        anno.userWidth = annoBox.style.width;
                        anno.userHeight = annoBox.style.height;
                        
                        // 实时保存大小到localStorage（使用股价坐标系）
                        const klinePrice = klineData.value[1]; // 收盘价
                        saveAnnotationPosition(currentTicker, anno.date, anno.text, {
                            left: annoBox.style.left,
                            top: annoBox.style.top,
                            width: annoBox.style.width,
                            height: annoBox.style.height
                        }, {
                            pixel: {x: klinePx, y: klinePy},
                            price: klinePrice,
                            dateIndex: dataIndex
                        }); // 传递完整K线数据用于股价坐标系计算
                    };

                    document.addEventListener('mousemove', onResizeMouseMove);
                    document.addEventListener('mouseup', onResizeMouseUp);
                });
            }
            
            // 为注释框添加右键菜单
            annoBox.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                e.stopPropagation();
                showAnnotationContextMenu(anno, e.clientX, e.clientY);
            });
        }
        
        // 显示图表区域右键菜单
        function showChartContextMenu(x, y, event) {
            if (!myChart) return;
            
            // 移除现有的图表右键菜单
            const existingMenu = document.querySelector('.chart-context-menu');
            if (existingMenu) {
                existingMenu.remove();
            }
            
            // 获取图表容器的位置
            const chartContainer = document.getElementById('chart-container');
            const chartRect = chartContainer.getBoundingClientRect();
            
            // 计算相对于图表的坐标
            const chartX = event.clientX - chartRect.left;
            const chartY = event.clientY - chartRect.top;
            
            // 使用ECharts的convertFromPixel来获取对应的数据坐标
            let targetDate = null;
            try {
                const dataCoord = myChart.convertFromPixel({ gridIndex: 0 }, [chartX, chartY]);
                if (dataCoord && dataCoord.length >= 2) {
                    const dataIndex = Math.round(dataCoord[0]);
                    const chartOption = myChart.getOption();
                    if (chartOption && chartOption.xAxis && chartOption.xAxis[0].data) {
                        const allDates = chartOption.xAxis[0].data;
                        if (dataIndex >= 0 && dataIndex < allDates.length) {
                            targetDate = allDates[dataIndex];
                        }
                    }
                }
            } catch (error) {
                console.log('无法获取图表坐标，可能点击区域超出范围');
                return;
            }
            
            if (!targetDate) {
                console.log('无法确定目标日期');
                return;
            }
            
            // 创建菜单容器
            const menu = document.createElement('div');
            menu.className = 'chart-context-menu';
            menu.style.position = 'fixed';
            menu.style.left = x + 'px';
            menu.style.top = y + 'px';
            menu.style.zIndex = '10001';
            
            menu.innerHTML = `
                <div class="context-menu-item" data-action="ai-analysis" data-date="${targetDate}">
                    AI自动分析 (${targetDate})
                </div>
                <div class="context-menu-item" data-action="add-annotation" data-date="${targetDate}">
                    📝 新增注释 (${targetDate})
                </div>
            `;
            
            // 添加到页面
            document.body.appendChild(menu);
            
            // 调整菜单位置，避免超出视窗
            const menuRect = menu.getBoundingClientRect();
            const windowWidth = window.innerWidth;
            const windowHeight = window.innerHeight;
            
            if (menuRect.right > windowWidth) {
                menu.style.left = (windowWidth - menuRect.width - 5) + 'px';
            }
            if (menuRect.bottom > windowHeight) {
                menu.style.top = (windowHeight - menuRect.height - 5) + 'px';
            }
            
            // 添加点击事件监听
            menu.addEventListener('click', async (e) => {
                const action = e.target.dataset.action;
                const date = e.target.dataset.date;
                
                if (action === 'ai-analysis' && date) {
                    await performContextMenuAIAnalysis(date);
                } else if (action === 'add-annotation' && date) {
                    await showAddAnnotationDialogWithDate(date);
                }
                
                menu.remove();
            });
            
            // 点击其他区域关闭菜单
            setTimeout(() => {
                document.addEventListener('click', function closeMenu() {
                    menu.remove();
                    document.removeEventListener('click', closeMenu);
                });
            }, 0);
        }
        
        // 显示新增注释对话框（预填充日期）
        async function showAddAnnotationDialogWithDate(date) {
            if (!dom.addAnnotationDialog) return;
            dom.addAnnotationDateInput.value = date;
            dom.addAnnotationTextInput.value = '正在获取股价数据...';
            dom.addAnnotationDialog.style.display = 'flex';
            
            // 优先使用图表数据自动填充股价信息
            if (currentTicker && date) {
                const stockChange = getStockChangeFromChart(date);
                if (stockChange) {
                    // 使用图表数据生成标准格式
                    const companyName = currentChartData ? currentChartData.companyName : currentTicker;
                    const formattedText = `${companyName} ${currentTicker} 股价异动时点：${date}\n${stockChange.changeText}`;
                    dom.addAnnotationTextInput.value = formattedText;
                    console.log(`[INFO] 使用图表数据自动填充: ${formattedText}`);
                } else {
                    // 图表数据获取失败，尝试API兜底
                    console.log('[INFO] 图表数据计算失败，尝试API兜底');
                    const stockData = await fetchStockDataForDate(currentTicker, date);
                    if (stockData && stockData.formatted_annotation_text) {
                        dom.addAnnotationTextInput.value = stockData.formatted_annotation_text;
                        console.log(`[INFO] API兜底成功: ${stockData.formatted_annotation_text}`);
                    } else {
                        // 都失败了，清空文本框
                        dom.addAnnotationTextInput.value = '';
                        console.log('[INFO] 所有数据源都失败，用户需手动输入');
                    }
                }
            } else {
                dom.addAnnotationTextInput.value = '';
            }
            
            // 自动聚焦到文本输入框
            setTimeout(() => {
                dom.addAnnotationTextInput.focus();
                // 选中文本方便用户修改
                dom.addAnnotationTextInput.select();
            }, 100);
        }

        // 显示注释右键菜单
        function showAnnotationContextMenu(annotation, x, y) {
            // 移除现有的右键菜单
            const existingMenu = document.querySelector('.annotation-context-menu');
            if (existingMenu) {
                existingMenu.remove();
            }
            
            // 创建菜单容器
            const menu = document.createElement('div');
            menu.className = 'annotation-context-menu';
            menu.style.position = 'fixed';
            menu.style.left = x + 'px';
            menu.style.top = y + 'px';
            menu.style.zIndex = '10000';
            
            // 判断是否为重点注释
            const isFavorite = annotation.is_favorite;
            const favoriteText = isFavorite ? '取消重点标记' : '标记为重点注释';
            const favoriteIcon = isFavorite ? '☆' : '★';
            
            // 判断是否已有AI分析
            const hasAIAnalysis = annotation.algorithm_type === 'ai_analysis';
            const isAnalyzing = globalAIAnalysisState.isAnalyzing(annotation.id);
            const aiText = hasAIAnalysis ? 'AI已分析' : (isAnalyzing ? 'AI分析中...' : 'AI分析');
            const aiDisabled = hasAIAnalysis || isAnalyzing;
            
            menu.innerHTML = `
                <div class="context-menu-item" data-action="ai-analysis" ${aiDisabled ? 'style="opacity: 0.6; cursor: not-allowed;"' : ''}>
                    ${aiText}
                </div>
                <div class="context-menu-item" data-action="favorite">
                    ${favoriteIcon} ${favoriteText}
                </div>
                <div class="context-menu-item" data-action="delete">
                    🗑️ 删除注释
                </div>
            `;
            
            // 添加到页面
            document.body.appendChild(menu);
            
            // 调整菜单位置，避免超出视窗
            const menuRect = menu.getBoundingClientRect();
            const windowWidth = window.innerWidth;
            const windowHeight = window.innerHeight;
            
            if (menuRect.right > windowWidth) {
                menu.style.left = (x - menuRect.width) + 'px';
            }
            if (menuRect.bottom > windowHeight) {
                menu.style.top = (y - menuRect.height) + 'px';
            }
            
            // 添加事件监听器
            menu.addEventListener('click', async (e) => {
                e.stopPropagation();
                const action = e.target.dataset.action;
                
                if (action === 'ai-analysis') {
                    // 如果已有AI分析或正在分析中，不执行任何操作
                    const hasAIAnalysis = annotation.algorithm_type === 'ai_analysis';
                    const isAnalyzing = globalAIAnalysisState.isAnalyzing(annotation.id);
                    
                    if (!hasAIAnalysis && !isAnalyzing) {
                        menu.remove();
                        try {
                            await performAIAnalysis(annotation);
                        } catch (error) {
                            showNotification(`❌ AI分析失败: ${error.message}`, 'error', 5000);
                        }
                        return;
                    }
                } else if (action === 'favorite') {
                    await toggleAnnotationFavorite(annotation);
                } else if (action === 'delete') {
                    await removeAnnotation(annotation.id);
                }
                
                menu.remove();
            });
            
            // 点击其他地方关闭菜单
            setTimeout(() => {
                document.addEventListener('click', function closeMenu() {
                    menu.remove();
                    document.removeEventListener('click', closeMenu);
                }, 0);
            }, 0);
        }
        
        // 切换注释重点标记
        async function toggleAnnotationFavorite(annotation) {
            try {
                const url = `/api/annotations/favorite/${encodeURIComponent(annotation.id)}`;
                const method = annotation.is_favorite ? 'DELETE' : 'POST';
                
                const response = await fetch(url, {
                    method: method,
                    headers: {
                        'Content-Type': 'application/json'
                    }
                });
                
                if (response.ok) {
                    // 更新本地数据
                    annotation.is_favorite = !annotation.is_favorite;
                    
                    // 显示通知
                    const message = annotation.is_favorite ? '✅ 已标记为重点注释' : '✅ 已取消重点标记';
                    showNotification(message, 'success');
                    
                    // 重新绘制注释以更新视觉效果
                    renderCustomAnnotations();
                } else {
                    const errorData = await response.json();
                    throw new Error(errorData.error || '操作失败');
                }
            } catch (error) {
                console.error('切换重点标记失败:', error);
                showNotification(`操作失败: ${error.message}`, 'error');
            }
        }
        
        async function removeAnnotation(annotationId) {
            console.log('[DEBUG] 删除注释:', annotationId);
            
            const annotationToRemove = currentAnnotations.find(anno => anno.id === annotationId);
            if (!annotationToRemove) {
                console.warn('[WARN] 未找到要删除的注释:', annotationId);
                return;
            }

            // 所有注释类型都调用后端API进行软删除
            try {
                const response = await fetch(`/api/annotation/${encodeURIComponent(annotationId)}`, {
                    method: 'DELETE',
                });
                
                if (!response.ok) {
                    const errorData = await response.json();
                    console.error('[ERROR] 删除注释失败:', errorData);
                    alert(`删除失败: ${errorData.error || '未知错误'}`);
                    return;
                }
                
                const result = await response.json();
                console.log('[SUCCESS] 注释删除成功:', result.message);
                
                // 从本地注释列表中移除
                currentAnnotations = currentAnnotations.filter(anno => anno.id !== annotationId);
                
                // 重新渲染界面
                renderCustomAnnotations();
                updateAnnotationList();
                
                // 显示成功提示
                showNotification('✅ 注释已移至回收站', 'success');
                
            } catch (error) {
                console.error('[ERROR] 删除注释时出错:', error);
                alert(`删除失败: ${error.message}`);
            }
        }
        
        function updateAnnotationList() {
            if(!dom.annotationList) return;
            dom.annotationList.innerHTML = '';

            // 添加与图表相同的过滤逻辑
            const enabledAnnotationTypes = new Set();
            if (dom.priceVolumeCheck.checked) enabledAnnotationTypes.add('price_volume');
            if (dom.volumePriceCheck.checked) enabledAnnotationTypes.add('volume_stable_price');
            if (dom.priceOnlyCheck.checked) enabledAnnotationTypes.add('price_only');
            if (dom.volumeOnlyCheck.checked) enabledAnnotationTypes.add('volume_only');

            let visibleAnnotations = currentAnnotations.filter(anno =>
                enabledAnnotationTypes.has(anno.type) ||
                anno.type === 'manual' || // 手动添加的注释始终显示
                anno.algorithm_type === 'ai_analysis' // AI分析注释始终显示（修复：检查algorithm_type）
            );

            // V5.8.4: 应用时间筛选
            if (timeFilterState.enabled && timeFilterState.mode !== 'all') {
                visibleAnnotations = applyTimeFilter(visibleAnnotations);
            }

            if (visibleAnnotations.length === 0) {
                dom.annotationList.innerHTML = '<p style="text-align: center; color: #6c757d; font-style: italic;">暂无注释</p>';
                return;
            }

            // V4.8.2: 按选定的排序方式排序注释
            visibleAnnotations = sortAnnotations(visibleAnnotations, annotationSortOrder);

            visibleAnnotations.forEach(anno => {
                const item = document.createElement('div');
                item.className = 'annotation-item';
                
                // V4.8.3: 检查是否选中
                const isSelected = batchAnalysisState.selectedAnnotations.has(anno.id);
                if (isSelected) {
                    item.classList.add('selected');
                }
                
                // V4.8.1: 检查是否需要AI分析按钮（算法异动 + 手动注释）
                const needsAIAnalysis = ['price_volume', 'volume_stable_price', 'price_only', 'volume_only'].includes(anno.type) || anno.type === 'manual';
                
                // V4.8.3: 调整布局以容纳复选框和AI分析按钮
                if (needsAIAnalysis) {
                    item.style.gridTemplateColumns = '20px 100px 1fr 80px 60px 60px';
                } else {
                    item.style.gridTemplateColumns = '20px 100px 1fr 60px 60px';
                }

                // V4.8.3: 添加复选框
                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.className = 'annotation-checkbox';
                checkbox.checked = isSelected;
                checkbox.addEventListener('change', () => {
                    toggleAnnotationSelection(anno.id);
                });

                const dateEl = document.createElement('span');
                dateEl.textContent = anno.date;

                const textEl = document.createElement('span');
                textEl.textContent = anno.text;
                textEl.title = anno.text;
                textEl.style.whiteSpace = 'nowrap';
                textEl.style.overflow = 'hidden';
                textEl.style.textOverflow = 'ellipsis';
                
                item.appendChild(checkbox);
                item.appendChild(dateEl);
                item.appendChild(textEl);
                
                // V4.8.1: 为算法异动和手动注释添加AI分析按钮
                if (needsAIAnalysis) {
                    // 检查当前注释是否已包含AI分析内容
                    const hasAIAnalysis = anno.algorithm_type === 'ai_analysis';
                    
                    const aiBtn = document.createElement('button');
                    aiBtn.className = 'item-ai-analyze';
                    aiBtn.setAttribute('data-annotation-id', anno.id); // 添加标识符用于精准状态管理
                    
                    // 检查各种状态以决定按钮显示
                    const isAnalyzing = globalAIAnalysisState.isAnalyzing(anno.id);
                    const isInBatchQueue = batchAnalysisState.processingQueue.includes(anno.id) ||
                                          batchAnalysisState.currentBatch.includes(anno.id);
                    const isBatchFailed = batchAnalysisState.failedTasks.has(anno.id);

                    if (hasAIAnalysis) {
                        aiBtn.textContent = '已分析';
                        aiBtn.disabled = true;
                        aiBtn.style.opacity = '0.6';
                        aiBtn.style.backgroundColor = '#28a745';
                        aiBtn.style.color = 'white';
                        aiBtn.title = '该异动已有AI分析结果，点击编辑可查看详情';
                    } else if (isAnalyzing || isInBatchQueue) {
                        aiBtn.textContent = isInBatchQueue ? '队列中...' : '分析中...';
                        aiBtn.disabled = true;
                        aiBtn.style.opacity = '1';
                        aiBtn.style.backgroundColor = '#007bff';
                        aiBtn.style.color = 'white';
                        aiBtn.title = isInBatchQueue ? '任务在批量分析队列中' : '正在进行AI分析';

                        // 为批量队列中的任务添加动画效果
                        if (isInBatchQueue && batchAnalysisState.isProcessing) {
                            aiBtn.style.animation = 'pulse 2s infinite';
                        }
                    } else if (isBatchFailed) {
                        aiBtn.textContent = '重新分析';
                        aiBtn.disabled = false;
                        aiBtn.style.opacity = '1';
                        aiBtn.style.backgroundColor = '#dc3545';
                        aiBtn.style.color = 'white';
                        aiBtn.title = '批量分析失败，点击重新分析';
                    } else {
                        aiBtn.textContent = '自动分析';
                        aiBtn.disabled = false;
                        aiBtn.style.opacity = '1';
                        aiBtn.style.backgroundColor = '';
                        aiBtn.style.color = '';
                        aiBtn.style.animation = '';
                        aiBtn.title = '点击开始AI异动分析';
                    }

                    // 添加点击事件监听器（仅对未禁用的按钮）
                    if (!aiBtn.disabled) {
                        aiBtn.addEventListener('click', () => {
                            // 检查是否已在全局状态中分析
                            if (globalAIAnalysisState.isAnalyzing(anno.id)) {
                                showNotification('⚠️ 该异动正在分析中，请等待完成', 'warning');
                                return;
                            }

                            // 根据按钮文本决定调用哪个函数
                            if (aiBtn.textContent === '检查结果') {
                                // 调用检查结果函数
                                handleCheckResult(anno.id, aiBtn);
                            } else {
                                // 调用正常的AI分析函数
                                performAIAnalysis(anno, aiBtn);
                            }
                        });
                    }
                    
                    item.appendChild(aiBtn);
                }
                
                // 为所有注释类型添加编辑按钮
                const editBtn = document.createElement('button');
                editBtn.className = 'item-edit';
                editBtn.textContent = '编辑';
                editBtn.addEventListener('click', () => {
                    showEditAnnotationDialog(anno);
                });
                item.appendChild(editBtn);
                
                const deleteBtn = document.createElement('button');
                deleteBtn.className = 'item-delete';
                deleteBtn.textContent = '删除';
                deleteBtn.addEventListener('click', () => {
                    removeAnnotation(anno.id);
                });
                item.appendChild(deleteBtn);

                dom.annotationList.appendChild(item);
            });
        }
        
        function showAddAnnotationDialog() {
            if (!dom.addAnnotationDialog) return;
            dom.addAnnotationDateInput.value = '';
            dom.addAnnotationTextInput.value = '';
            dom.addAnnotationDialog.style.display = 'flex';
        }

        function hideAddAnnotationDialog() {
            if (!dom.addAnnotationDialog) return;
            dom.addAnnotationDialog.style.display = 'none';
        }

        // 导出功能相关函数
        function showExportAnnotationDialog() {
            if (!dom.exportAnnotationDialog) return;
            
            // 设置默认日期范围（最近30天）
            const today = new Date();
            const thirtyDaysAgo = new Date();
            thirtyDaysAgo.setDate(today.getDate() - 30);
            
            dom.exportStartDateInput.value = thirtyDaysAgo.toISOString().split('T')[0];
            dom.exportEndDateInput.value = today.toISOString().split('T')[0];
            
            dom.exportAnnotationDialog.style.display = 'flex';
        }

        function hideExportAnnotationDialog() {
            if (!dom.exportAnnotationDialog) return;
            dom.exportAnnotationDialog.style.display = 'none';
        }

        async function exportAnnotationData() {
            try {
                const startDate = dom.exportStartDateInput.value;
                const endDate = dom.exportEndDateInput.value;
                
                if (!startDate || !endDate) {
                    showNotification('请选择开始和结束日期', 'warning');
                    return;
                }
                
                if (startDate > endDate) {
                    showNotification('开始日期不能晚于结束日期', 'warning');
                    return;
                }
                
                // 获取当前算法参数
                const priceStd = dom.priceStdInput.value;
                const volumeStd = dom.volumeStdInput.value;
                const priceOnlyStd = dom.priceOnlyStdInput.value;
                const volumeOnlyStd = dom.volumeOnlyStdInput.value;
                
                const shortTermZig = dom.shortTermZigInput.value;
                const mediumTermZig = dom.mediumTermZigInput.value;
                const longTermZig = dom.longTermZigInput.value;
                const zigPhaseSource = dom.zigPhaseSourceSelect.value;
                
                const volumeShortTermZig = dom.volumeShortTermZigInput.value;
                const volumeMediumTermZig = dom.volumeMediumTermZigInput.value;
                const volumeLongTermZig = dom.volumeLongTermZigInput.value;
                const volumeZigPhaseSource = dom.volumeZigPhaseSourceSelect.value;
                
                // 构建带算法参数的API URL
                const exportUrl = `/api/annotations/export?ticker=${encodeURIComponent(currentTicker)}` +
                                `&start_date=${startDate}&end_date=${endDate}` +
                                `&price_std=${priceStd}&volume_std=${volumeStd}` +
                                `&price_only_std=${priceOnlyStd}&volume_only_std=${volumeOnlyStd}` +
                                `&short_term_zig=${shortTermZig}&medium_term_zig=${mediumTermZig}` +
                                `&long_term_zig=${longTermZig}&zig_phase_source=${zigPhaseSource}` +
                                `&volume_short_term_zig=${volumeShortTermZig}` +
                                `&volume_medium_term_zig=${volumeMediumTermZig}` +
                                `&volume_long_term_zig=${volumeLongTermZig}` +
                                `&volume_zig_phase_source=${volumeZigPhaseSource}`;
                
                // 调用后端API获取数据
                const response = await fetch(exportUrl);
                const result = await response.json();
                
                if (!response.ok) {
                    throw new Error(result.error || '导出失败');
                }
                
                if (result.data.length === 0) {
                    showNotification('选定时间段内暂无标注数据', 'info');
                    return;
                }
                
                // 格式化数据为文本
                const formattedText = formatAnnotationDataForClipboard(result);
                
                // 复制到剪贴板
                await copyToClipboard(formattedText);
                
                // 显示成功提示
                showNotification('选取区间数据已复制到剪切板中', 'success', 1000);
                
                // 关闭对话框
                hideExportAnnotationDialog();
                
            } catch (error) {
                console.error('导出注释数据失败:', error);
                showNotification(`导出失败: ${error.message}`, 'error');
            }
        }

        function formatAnnotationDataForClipboard(result) {
            const { data, ticker, period, count } = result;
            
            // 获取公司名称，优先使用currentChartData中的companyName
            const companyName = currentChartData?.companyName || ticker;
            
            let text = `${ticker} ${companyName} 股价异动时点\n`;
            text += `时间段: ${period}\n`;
            text += `\n${'='.repeat(50)}\n\n`;
            
            data.forEach((annotation, index) => {
                text += `${index + 1}. ${annotation.date}\n`;
                text += `   ${annotation.text}\n\n`;
            });
            
            return text;
        }

        async function copyToClipboard(text) {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                // 现代浏览器使用Clipboard API
                await navigator.clipboard.writeText(text);
            } else {
                // 兼容旧版浏览器
                const textArea = document.createElement('textarea');
                textArea.value = text;
                textArea.style.position = 'fixed';
                textArea.style.left = '-999999px';
                textArea.style.top = '-999999px';
                document.body.appendChild(textArea);
                textArea.focus();
                textArea.select();
                
                try {
                    document.execCommand('copy');
                } catch (error) {
                    throw new Error('复制到剪贴板失败');
                } finally {
                    document.body.removeChild(textArea);
                }
            }
        }
        
        // 悬停预览相关变量
        let hoverTimeout = null;
        let hideTimeout = null;
        let currentHoverPopup = null;
        
        // 悬停预览函数
        function showHoverPreview(annotation, clientX, clientY) {
            // 移除之前的悬停预览
            if (currentHoverPopup) {
                currentHoverPopup.remove();
                currentHoverPopup = null;
            }
            
            const popup = document.createElement('div');
            popup.className = 'annotation-hover-preview';
            popup.style.cssText = `
                position: fixed;
                left: ${clientX + 10}px;
                top: ${clientY - 10}px;
                background: rgba(255, 255, 255, 0.95);
                border: 2px solid ${annotation.borderColor || '#4CAF50'};
                border-radius: 6px;
                padding: 8px;
                box-shadow: 0 2px 8px rgba(0,0,0,0.2);
                z-index: 999;
                max-width: 220px;
                max-height: 120px;
                overflow-y: auto;
                font-family: Arial, sans-serif;
                font-size: 12px;
                line-height: 1.3;
                pointer-events: auto;
                cursor: default;
            `;
            
            // 提取第一大段内容用于悬停预览
            function getFirstParagraph(text) {
                if (!text) return '';
                
                // 按双换行符分割（空行分隔）
                const paragraphs = text.split(/\n\s*\n/);
                if (paragraphs.length > 0 && paragraphs[0].trim()) {
                    return paragraphs[0].trim();
                }
                
                // 如果没有空行分隔，按单换行符分割，取前几行
                const lines = text.split(/\n/);
                if (lines.length > 3) {
                    return lines.slice(0, 3).join('\n').trim() + '...';
                }
                
                return text.trim();
            }
            
            const firstParagraph = getFirstParagraph(annotation.text);
            let displayText = `${annotation.date}\n${firstParagraph}`;
            if (annotation.type === 'manual') {
                displayText += '\n[手动注释]';
            }
            
            popup.innerHTML = `<div style="white-space: pre-line; color: #333;">${displayText}</div>`;
            
            document.body.appendChild(popup);
            currentHoverPopup = popup;
            
            // 为弹窗添加鼠标事件，保持显示当鼠标在弹窗上时
            popup.addEventListener('mouseenter', () => {
                // 清除隐藏计时器
                if (hideTimeout) {
                    clearTimeout(hideTimeout);
                    hideTimeout = null;
                }
            });
            
            popup.addEventListener('mouseleave', () => {
                // 如果当前有活跃的弹窗，不隐藏悬停预览（避免干扰）
                if (activePopupAnnotation && activePopupAnnotation.id === annotation.id) {
                    return;
                }
                // 延迟隐藏弹窗
                hideTimeout = setTimeout(() => {
                    if (currentHoverPopup === popup) {
                        popup.remove();
                        currentHoverPopup = null;
                    }
                }, 200);
            });
            
            // 调整位置避免超出屏幕
            const rect = popup.getBoundingClientRect();
            if (rect.right > window.innerWidth) {
                popup.style.left = `${clientX - rect.width - 10}px`;
            }
            if (rect.bottom > window.innerHeight) {
                popup.style.top = `${clientY - rect.height - 10}px`;
            }
        }
        
        // 用于标记是否有活跃的弹窗（防止悬停预览干扰）
        let activePopupAnnotation = null;
        
        // 注释弹窗显示函数
        function showAnnotationPopup(annotation, clientX, clientY) {
            // 移除之前的弹窗
            const existingPopup = document.querySelector('.annotation-popup');
            if (existingPopup) {
                existingPopup.remove();
            }
            
            // 清除悬停预览
            if (currentHoverPopup) {
                currentHoverPopup.remove();
                currentHoverPopup = null;
            }
            if (hoverTimeout) {
                clearTimeout(hoverTimeout);
                hoverTimeout = null;
            }
            if (hideTimeout) {
                clearTimeout(hideTimeout);
                hideTimeout = null;
            }
            
            // 标记当前有活跃的弹窗
            activePopupAnnotation = annotation;
            
            // 创建弹窗元素
            const popup = document.createElement('div');
            popup.className = 'annotation-popup';
            popup.style.cssText = `
                position: fixed;
                left: ${clientX + 10}px;
                top: ${clientY - 10}px;
                background: white;
                border: 2px solid ${annotation.borderColor || '#4CAF50'};
                border-radius: 8px;
                padding: 12px;
                box-shadow: 0 4px 12px rgba(0,0,0,0.3);
                z-index: 1000;
                max-width: 280px;
                max-height: 200px;
                overflow-y: auto;
                font-family: Arial, sans-serif;
                font-size: 14px;
                line-height: 1.4;
            `;
            
            // 创建弹窗内容
            let displayText = `${annotation.date}\n${annotation.text}`;
            if (annotation.type === 'manual') {
                displayText += '\n[手动注释]';
            }
            
            // 检查是否已有AI分析内容或正在分析中
            const hasAIAnalysis = annotation.algorithm_type === 'ai_analysis';
            const isCurrentlyAnalyzing = globalAIAnalysisState.isAnalyzing(annotation.id);
            
            popup.innerHTML = `
                <div style="white-space: pre-line; margin-bottom: 10px; color: #333;">${displayText}</div>
                <div style="display: flex; gap: 8px; justify-content: flex-end;">
                    <button class="popup-ai-btn" 
                            style="padding: 4px 8px; background: ${hasAIAnalysis || isCurrentlyAnalyzing ? '#6c757d' : '#ff9800'}; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 12px; ${hasAIAnalysis ? 'opacity: 0.7;' : ''} ${isCurrentlyAnalyzing ? 'background: linear-gradient(45deg, #ff6b6b, #4ecdc4, #45b7d1, #96ceb4, #ffa726, #ab47bc); background-size: 400% 400%; animation: rainbow-pulse 2s ease-in-out infinite;' : ''}"
                            ${hasAIAnalysis || isCurrentlyAnalyzing ? 'disabled' : ''}>
                        ${hasAIAnalysis ? '已分析' : (isCurrentlyAnalyzing ? '分析中...' : 'AI分析')}
                    </button>
                    <button class="popup-edit-btn" 
                            style="padding: 4px 8px; background: #2196F3; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 12px;">编辑</button>
                    <button class="popup-close-btn"
                            style="padding: 4px 8px; background: #f44336; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 12px;">关闭</button>
                </div>
            `;
            
            // 为AI分析按钮添加事件监听器
            const aiBtn = popup.querySelector('.popup-ai-btn');
            if (aiBtn && !hasAIAnalysis && !isCurrentlyAnalyzing) {
                aiBtn.addEventListener('click', async () => {
                    // 保存弹窗引用用于后续更新
                    const popupRef = popup;
                    const buttonRef = aiBtn;
                    
                    try {
                        // 更新按钮状态为加载中
                        buttonRef.textContent = '分析中...';
                        buttonRef.style.background = '#6c757d';
                        buttonRef.disabled = true;
                        
                        // 显示彩虹边框动画效果
                        buttonRef.style.background = 'linear-gradient(45deg, #ff6b6b, #4ecdc4, #45b7d1, #96ceb4, #ffa726, #ab47bc)';
                        buttonRef.style.backgroundSize = '400% 400%';
                        buttonRef.style.animation = 'rainbow-pulse 2s ease-in-out infinite';
                        
                        // 调用AI分析，使用全局的performAIAnalysis函数但需要适配
                        await performAIAnalysisForPopup(annotation, buttonRef, popupRef);
                        
                    } catch (error) {
                        console.error('[弹窗AI分析] 分析失败:', error);
                        
                        // 恢复按钮状态
                        buttonRef.textContent = 'AI分析';
                        buttonRef.style.background = '#ff9800';
                        buttonRef.style.animation = '';
                        buttonRef.disabled = false;
                        
                        showNotification(`❌ AI分析失败: ${error.message}`, 'error', 6000);
                    }
                });
            }
            
            // 为编辑按钮添加事件监听器，点击时先关闭弹窗再打开编辑对话框
            const editBtn = popup.querySelector('.popup-edit-btn');
            editBtn.addEventListener('click', () => {
                popup.remove(); // 先关闭弹窗
                activePopupAnnotation = null; // 清除活跃弹窗标记
                showEditAnnotationDialog(annotation); // 再打开编辑对话框
            });
            
            // 为关闭按钮添加事件监听器
            const closeBtn = popup.querySelector('.popup-close-btn');
            closeBtn.addEventListener('click', () => {
                popup.remove();
                activePopupAnnotation = null; // 清除活跃弹窗标记
            });
            
            document.body.appendChild(popup);
            
            // 添加点击外部关闭功能
            const closeOnOutsideClick = (e) => {
                if (!popup.contains(e.target)) {
                    popup.remove();
                    activePopupAnnotation = null; // 清除活跃弹窗标记
                    document.removeEventListener('click', closeOnOutsideClick);
                }
            };
            // 延迟添加事件监听器，避免立即触发
            setTimeout(() => {
                document.addEventListener('click', closeOnOutsideClick);
            }, 100);
            
            // 调整弹窗位置，确保不超出屏幕边界
            const rect = popup.getBoundingClientRect();
            if (rect.right > window.innerWidth) {
                popup.style.left = `${clientX - rect.width - 10}px`;
            }
            if (rect.bottom > window.innerHeight) {
                popup.style.top = `${clientY - rect.height - 10}px`;
            }
        }

        // 编辑注释对话框相关函数
        let currentEditingAnnotation = null;
        
        function showEditAnnotationDialog(annotation) {
            console.log('[DEBUG] 显示编辑对话框, 注释对象:', annotation);
            
            if (!dom.editAnnotationDialog) {
                console.error('[ERROR] 编辑对话框DOM元素未找到');
                return;
            }
            
            if (!annotation || !annotation.id) {
                console.error('[ERROR] 注释对象或ID无效:', annotation);
                alert('注释数据无效，无法编辑');
                return;
            }
            
            console.log('[DEBUG] 注释ID:', annotation.id);
            console.log('[DEBUG] 注释类型:', annotation.type);
            console.log('[DEBUG] 注释日期:', annotation.date);
            console.log('[DEBUG] 注释内容:', annotation.text);
            
            currentEditingAnnotation = annotation;
            dom.editAnnotationDateInput.value = annotation.date;
            dom.editAnnotationTextInput.value = annotation.text;
            dom.editAnnotationDialog.style.display = 'flex';
        }

        function hideEditAnnotationDialog() {
            if (!dom.editAnnotationDialog) return;
            dom.editAnnotationDialog.style.display = 'none';
            currentEditingAnnotation = null;
        }

        // 在编辑对话框中自动填充股价数据（优先使用图表数据）
        async function fillStockDataInEditDialog() {
            const date = dom.editAnnotationDateInput.value;
            
            if (!currentTicker) {
                alert('未选择股票代码，无法获取股价数据');
                return;
            }
            
            if (!date) {
                alert('请先选择日期');
                return;
            }
            
            // 设置按钮状态为加载中
            const originalText = dom.fillStockDataBtn.textContent;
            dom.fillStockDataBtn.textContent = '⏳ 计算中...';
            dom.fillStockDataBtn.disabled = true;
            
            try {
                // 优先使用图表数据
                const stockChange = getStockChangeFromChart(date);
                let formattedText = null;
                
                if (stockChange) {
                    // 使用图表数据生成标准格式
                    const companyName = currentChartData ? currentChartData.companyName : currentTicker;
                    formattedText = `${companyName} ${currentTicker} 股价异动时点：${date}\n${stockChange.changeText}`;
                    console.log(`[INFO] 使用图表数据填充编辑框: ${formattedText}`);
                } else {
                    // 图表数据计算失败，尝试API兜底
                    console.log('[INFO] 图表数据计算失败，尝试API兜底');
                    const stockData = await fetchStockDataForDate(currentTicker, date);
                    if (stockData && stockData.formatted_annotation_text) {
                        formattedText = stockData.formatted_annotation_text;
                        console.log(`[INFO] API兜底成功: ${formattedText}`);
                    }
                }
                
                if (formattedText) {
                    // 将格式化的股价信息填充到文本框中
                    const currentText = dom.editAnnotationTextInput.value.trim();
                    if (currentText && !confirm('文本框中已有内容，是否要替换为股价数据？')) {
                        return;
                    }
                    
                    dom.editAnnotationTextInput.value = formattedText;
                    
                    // 选中文本方便用户修改
                    dom.editAnnotationTextInput.focus();
                    dom.editAnnotationTextInput.select();
                } else {
                    alert('无法获取股价数据，请确认日期是否在图表数据范围内，或手动输入');
                }
            } catch (error) {
                console.error('[ERROR] 填充股价数据失败:', error);
                alert('获取股价数据时出错，请稍后重试');
            } finally {
                // 恢复按钮状态
                dom.fillStockDataBtn.textContent = originalText;
                dom.fillStockDataBtn.disabled = false;
            }
        }

        async function saveEditAnnotation() {
            console.log('[DEBUG] 开始保存编辑注释');
            
            if (!currentEditingAnnotation) {
                console.error('[ERROR] 没有正在编辑的注释');
                alert('没有正在编辑的注释');
                return;
            }
            
            console.log('[DEBUG] 当前编辑的注释:', currentEditingAnnotation);
            
            const newDate = dom.editAnnotationDateInput.value;
            const newText = dom.editAnnotationTextInput.value.trim();

            console.log('[DEBUG] 新的日期:', newDate);
            console.log('[DEBUG] 新的内容:', newText);

            if (!newDate) {
                alert('请选择一个日期');
                return;
            }
            if (!newText) {
                alert('请输入注释内容');
                return;
            }
            
            const annotationId = currentEditingAnnotation.id;
            console.log('[DEBUG] 准备更新注释ID:', annotationId);
            console.log('[DEBUG] 注释ID类型:', typeof annotationId);
            console.log('[DEBUG] 注释ID长度:', annotationId ? annotationId.length : 'null');
            
            // 验证ID有效性
            if (!annotationId || annotationId.trim() === '') {
                console.error('[ERROR] 注释ID无效');
                alert('注释ID无效，无法更新');
                return;
            }
            
            // URL编码处理 - 使用更安全的编码方式
            let encodedId;
            try {
                // 对整个ID进行编码，确保所有特殊字符都被正确处理
                encodedId = encodeURIComponent(annotationId);
                console.log('[DEBUG] 编码前ID:', annotationId);
                console.log('[DEBUG] 编码后ID:', encodedId);
                
                // 验证编码是否改变了ID（说明包含特殊字符）
                if (encodedId !== annotationId) {
                    console.log('[DEBUG] ID包含特殊字符，已进行URL编码');
                }
            } catch (error) {
                console.error('[ERROR] URL编码失败:', error);
                alert('ID编码失败，无法更新');
                return;
            }
            
            const apiUrl = `/api/annotation/${encodedId}`;
            console.log('[DEBUG] API URL:', apiUrl);

            try {
                const requestData = {
                    date: newDate,
                    text: newText
                };
                
                console.log('[DEBUG] 请求数据:', requestData);

                const response = await fetch(apiUrl, {
                    method: 'PUT',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(requestData)
                });

                console.log('[DEBUG] 响应状态:', response.status);
                console.log('[DEBUG] 响应状态文本:', response.statusText);
                console.log('[DEBUG] 响应头:', response.headers);

                if (!response.ok) {
                    const responseText = await response.text();
                    console.error('[ERROR] API响应错误文本:', responseText);
                    
                    let errorData;
                    try {
                        errorData = JSON.parse(responseText);
                    } catch (parseError) {
                        errorData = { error: responseText };
                    }
                    
                    console.error('[ERROR] API调用失败:', errorData);
                    throw new Error(errorData.error || '更新注释失败');
                }

                const result = await response.json();
                console.log('[DEBUG] 更新成功:', result);

                // 更新本地数据
                const index = currentAnnotations.findIndex(anno => anno.id === currentEditingAnnotation.id);
                if (index !== -1) {
                    console.log('[DEBUG] 更新本地注释数据, 索引:', index);
                    console.log('[DEBUG] 更新前:', currentAnnotations[index]);
                    currentAnnotations[index].date = newDate;
                    currentAnnotations[index].text = newText;
                    console.log('[DEBUG] 更新后:', currentAnnotations[index]);
                } else {
                    console.warn('[WARN] 在本地数据中未找到注释:', currentEditingAnnotation.id);
                }

                // 重新渲染
                renderCustomAnnotations();
                updateAnnotationList();
                hideEditAnnotationDialog();

                console.log('[SUCCESS] 注释更新成功');
                showNotification('✏️ 注释更新成功', 'success');
            } catch (error) {
                console.error('[ERROR] 更新注释失败:', error);
                console.error('[ERROR] 错误堆栈:', error.stack);
                alert(`更新失败: ${error.message}`);
            }
        }

        async function saveNewAnnotation() {
            const date = dom.addAnnotationDateInput.value;
            const text = dom.addAnnotationTextInput.value.trim();

            if (!date) {
                alert('请选择一个日期');
                return;
            }
            // V4.8.1: 允许创建空内容的手动注释，以便后续使用AI分析功能
            
            const chartOption = myChart.getOption();
            if (!chartOption || !chartOption.xAxis || !chartOption.xAxis[0].data) {
                alert('无法验证日期，图表数据不存在。');
                return;
            }
            const allDates = chartOption.xAxis[0].data;
            if (!allDates.includes(date)) {
                alert('该日期不在当前图表K线范围内，无法添加注释。');
                return;
            }

            const newAnnotation = {
                id: `${currentTicker}-${date}-${Date.now()}-manual`,
                date: date,
                text: text,
                ticker: currentTicker, // V3.1: 为后端添加ticker
                isManual: true,
                type: 'manual'
            };

            // V3.1: 调用后端API保存新注释
            try {
                const response = await fetch('/api/annotation', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(newAnnotation)
                });
                if (!response.ok) {
                    const errorData = await response.json();
                    throw new Error(errorData.error || '保存注释到服务器失败');
                }
                
                // 成功保存到后端后，更新UI
                currentAnnotations.push(newAnnotation);
                renderCustomAnnotations();
                updateAnnotationList();
                hideAddAnnotationDialog();

            } catch (error) {
                console.error('保存注释时出错:', error);
                alert(`保存注释失败: ${error.message}`);
            }
        }
        
        function addToHistory(action, data) { /* ... */ }
        function updateUndoRedoButtons() { /* ... */ }
        function undo() { /* ... */ }
        function redo() { /* ... */ }

        // V1.3: 渲染市场阶段的自定义图例
        function renderChartLegend(phaseColors) {
            if (!dom.chartLegend) return;

            const legendMapping = {
                'Uptrend': '上涨期',
                'Downtrend': '下跌期',
                'Consolidation': '盘整期'
            };

            dom.chartLegend.innerHTML = ''; // 清空现有图例

            for (const phase in legendMapping) {
                if (phaseColors[phase]) {
                    const item = document.createElement('div');
                    item.className = 'legend-item';

                    const colorBox = document.createElement('div');
                    colorBox.className = 'legend-color-box';
                    colorBox.style.backgroundColor = phaseColors[phase];

                    const text = document.createElement('span');
                    text.textContent = legendMapping[phase];

                    item.appendChild(colorBox);
                    item.appendChild(text);
                    dom.chartLegend.appendChild(item);
                }
            }
        }
        
        // --- V3.7: 回收站功能 ---
        
        // 标签页切换功能
        function switchTab(tabName) {
            if (tabName === 'annotation') {
                dom.annotationTab.classList.add('active');
                dom.recycleTab.classList.remove('active');
                dom.annotationTabContent.classList.add('active');
                dom.recycleTabContent.classList.remove('active');
            } else if (tabName === 'recycle') {
                dom.annotationTab.classList.remove('active');
                dom.recycleTab.classList.add('active');
                dom.annotationTabContent.classList.remove('active');
                dom.recycleTabContent.classList.add('active');
                // 切换到回收站时自动加载数据
                loadRecycleData();
            }
        }
        
        // 加载回收站数据
        async function loadRecycleData() {
            if (!currentTicker) {
                dom.recycleList.innerHTML = '<p style="text-align: center; color: #6c757d; font-style: italic;">请先选择股票</p>';
                return;
            }
            
            try {
                dom.recycleList.innerHTML = '<p style="text-align: center; color: #3498db; font-style: italic;">正在加载...</p>';
                
                const response = await fetch(`/api/recycle/annotations?ticker=${encodeURIComponent(currentTicker)}`);
                if (!response.ok) {
                    const errorData = await response.json();
                    throw new Error(errorData.error || '获取回收站数据失败');
                }
                
                const result = await response.json();
                const deletedAnnotations = result.deleted_annotations || [];
                
                renderRecycleList(deletedAnnotations);
                
            } catch (error) {
                console.error('加载回收站数据失败:', error);
                dom.recycleList.innerHTML = `<p style="text-align: center; color: #e74c3c; font-style: italic;">加载失败: ${error.message}</p>`;
            }
        }
        
        // 渲染回收站列表
        function renderRecycleList(deletedAnnotations) {
            if (!dom.recycleList) return;
            dom.recycleList.innerHTML = '';
            
            if (deletedAnnotations.length === 0) {
                dom.recycleList.innerHTML = '<p style="text-align: center; color: #6c757d; font-style: italic;">回收站为空</p>';
                return;
            }
            
            deletedAnnotations.forEach(anno => {
                const item = document.createElement('div');
                item.className = 'recycle-item';
                
                // 格式化删除时间
                const deletedDate = new Date(anno.deleted_at).toLocaleString('zh-CN');
                
                // 注释类型显示
                const typeMap = {
                    'manual': '手动',
                    'price_volume': '价量齐升/跌',
                    'volume_stable_price': '放量滞涨/跌',
                    'price_only': '价格异动',
                    'volume_only': '成交量异动'
                };
                const typeText = typeMap[anno.type] || anno.type;
                
                item.innerHTML = `
                    <span>${anno.date}</span>
                    <span class="annotation-type">${typeText}</span>
                    <span class="annotation-text" title="${anno.text}">${anno.text}</span>
                    <span class="deleted-date">${deletedDate}</span>
                    <button class="item-restore" onclick="restoreAnnotation('${anno.id}')">恢复</button>
                    <button class="item-permanent-delete" onclick="permanentDeleteAnnotation('${anno.id}')">永久删除</button>
                `;
                
                dom.recycleList.appendChild(item);
            });
        }
        
        // 恢复注释
        async function restoreAnnotation(annotationId) {
            try {
                const response = await fetch(`/api/recycle/restore/${encodeURIComponent(annotationId)}`, {
                    method: 'POST',
                });
                
                if (!response.ok) {
                    const errorData = await response.json();
                    throw new Error(errorData.error || '恢复注释失败');
                }
                
                const result = await response.json();
                showNotification('🔄 注释恢复成功', 'success');
                
                // 刷新回收站列表
                loadRecycleData();
                
                // 刷新主界面数据
                if (currentTicker) {
                    fetchStockData(currentTicker, currentPeriod);
                }
                
            } catch (error) {
                console.error('恢复注释失败:', error);
                alert(`恢复失败: ${error.message}`);
            }
        }
        
        // 永久删除注释
        async function permanentDeleteAnnotation(annotationId) {
            if (!confirm('确定要永久删除此注释吗？此操作无法撤销！')) {
                return;
            }
            
            try {
                const response = await fetch(`/api/recycle/permanent-delete/${encodeURIComponent(annotationId)}`, {
                    method: 'DELETE',
                });
                
                if (!response.ok) {
                    const errorData = await response.json();
                    throw new Error(errorData.error || '永久删除失败');
                }
                
                const result = await response.json();
                showNotification('🗑️ 注释已永久删除', 'warning');
                
                // 刷新回收站列表
                loadRecycleData();
                
            } catch (error) {
                console.error('永久删除失败:', error);
                alert(`删除失败: ${error.message}`);
            }
        }
        
        // --- AI分析功能 ---
        const analysisInProgress = new Map();
        
        // 全局AI分析状态管理
        const globalAIAnalysisState = {
            inProgress: new Map(), // annotationId -> { status, promise, startTime }
            
            // 开始AI分析
            start(annotationId, promise) {
                this.inProgress.set(annotationId, {
                    status: 'analyzing',
                    promise: promise,
                    startTime: Date.now()
                });
                console.log(`[全局AI状态] 开始分析: ${annotationId}`);
                this.updateAnnotationDotAnimation(annotationId, true);
            },
            
            // 完成AI分析
            complete(annotationId) {
                if (this.inProgress.has(annotationId)) {
                    const duration = Date.now() - this.inProgress.get(annotationId).startTime;
                    console.log(`[全局AI状态] 分析完成: ${annotationId}, 耗时: ${duration}ms`);
                    this.inProgress.delete(annotationId);
                    // 只移除这个特定注释的动画，不影响其他正在进行的分析
                    this.updateAnnotationDotAnimation(annotationId, false);
                }
            },
            
            // 获取分析状态
            isAnalyzing(annotationId) {
                return this.inProgress.has(annotationId);
            },
            
            // 获取分析Promise
            getPromise(annotationId) {
                const state = this.inProgress.get(annotationId);
                return state ? state.promise : null;
            },
            
            // 恢复所有正在进行的分析的动画状态（用于图表刷新后）
            restoreAllAnimations() {
                console.log(`[动画调试] 恢复 ${this.inProgress.size} 个正在进行的AI分析动画`);
                for (const annotationId of this.inProgress.keys()) {
                    this.updateAnnotationDotAnimation(annotationId, true);
                }
            },
            
            // 更新注释圆点动画
            updateAnnotationDotAnimation(annotationId, isAnalyzing) {
                console.log(`[动画调试] 更新注释动画: ${annotationId}, 分析中: ${isAnalyzing}`);
                // 找到对应的注释圆点元素
                const annotation = currentAnnotations.find(anno => anno.id === annotationId);
                if (!annotation) {
                    console.log(`[动画调试] 未找到注释: ${annotationId}`);
                    return;
                }
                
                // 处理注释框（时间跨度短时显示）
                const annoBoxes = document.querySelectorAll('.annotation-box');
                annoBoxes.forEach(box => {
                    if (box.dataset.annotationId === annotationId) {
                        if (isAnalyzing) {
                            // 添加彩虹边框动画
                            box.style.border = '3px solid transparent';
                            box.style.borderImage = 'conic-gradient(from 0deg, #ff0000, #ff7f00, #ffff00, #00ff00, #0000ff, #4b0082, #9400d3, #ff0000) 1';
                            box.style.animation = 'rainbow-border-rotate 2s linear infinite';
                            box.classList.add('ai-analyzing');
                        } else {
                            // 移除彩虹边框动画
                            box.style.border = '';
                            box.style.borderImage = '';
                            box.style.animation = '';
                            box.classList.remove('ai-analyzing');
                        }
                    }
                });
                
                // 处理注释圆点（时间跨度长时显示）
                const annoIcons = document.querySelectorAll('.annotation-icon');
                console.log(`[动画调试] 找到 ${annoIcons.length} 个注释圆点`);
                annoIcons.forEach((icon, index) => {
                    console.log(`[动画调试] 检查圆点[${index}]: ${icon.dataset.annotationId} vs ${annotationId}`);
                    if (icon.dataset.annotationId === annotationId) {
                        console.log(`[动画调试] 匹配到圆点[${index}], 分析状态: ${isAnalyzing}`);
                        if (isAnalyzing) {
                            // 为注释圆点添加rainbow-pulse背景渐变动画，使用!important确保覆盖CSS
                            icon.style.setProperty('background', 'linear-gradient(45deg, #ff6b6b, #4ecdc4, #45b7d1, #96ceb4, #ffa726, #ab47bc)', 'important');
                            icon.style.setProperty('background-size', '400% 400%', 'important');
                            icon.style.setProperty('animation', 'rainbow-pulse 2s ease-in-out infinite', 'important');
                            icon.classList.add('ai-analyzing');
                            console.log(`[动画调试] ✅ 为注释圆点 ${annotationId} 添加彩虹动画成功`);
                            
                            // 验证样式是否生效
                            setTimeout(() => {
                                const computedStyle = window.getComputedStyle(icon);
                                console.log(`[动画调试] 圆点[${index}]当前背景: ${computedStyle.background}`);
                                console.log(`[动画调试] 圆点[${index}]当前动画: ${computedStyle.animation}`);
                            }, 100);
                        } else {
                            // 移除rainbow-pulse动画，恢复原始样式
                            icon.style.removeProperty('background');
                            icon.style.removeProperty('background-size');
                            icon.style.removeProperty('animation');
                            icon.classList.remove('ai-analyzing');
                            console.log(`[动画调试] ❌ 移除注释圆点 ${annotationId} 的彩虹动画`);
                        }
                    }
                });
            }
        }; // 跟踪正在分析的注释 ID -> 按钮元素
        
        // 更新按钮状态的辅助函数
        function updateAIAnalysisButtonState(annotationId, state, button = null) {
            // 如果没有传入按钮，查找按钮
            if (!button) {
                button = document.querySelector(`[data-annotation-id="${annotationId}"]`);
            }
            
            if (!button) return;
            
            switch (state) {
                case 'analyzing':
                    button.disabled = true;
                    button.textContent = '分析中...';
                    button.classList.add('loading');
                    // 添加彩虹背景动画效果
                    button.style.background = 'linear-gradient(45deg, #ff6b6b, #4ecdc4, #45b7d1, #96ceb4, #ffa726, #ab47bc)';
                    button.style.backgroundSize = '400% 400%';
                    button.style.animation = 'rainbow-pulse 2s ease-in-out infinite';
                    button.title = '正在进行AI分析，请稍候...';
                    break;
                case 'completed':
                    button.disabled = true;
                    button.textContent = '已分析';
                    button.classList.remove('loading');
                    // 清理彩虹动画样式
                    button.style.background = '';
                    button.style.backgroundSize = '';
                    button.style.animation = '';
                    button.style.opacity = '0.6';
                    button.title = '该异动已有AI分析结果，可点击编辑按钮查看详情';
                    break;
                case 'ready':
                    button.disabled = false;
                    button.textContent = '自动分析';
                    button.classList.remove('loading');
                    // 清理彩虹动画样式
                    button.style.background = '';
                    button.style.backgroundSize = '';
                    button.style.animation = '';
                    button.style.opacity = '1';
                    button.title = '点击开始AI异动分析';
                    break;
                case 'error':
                    button.disabled = false;
                    button.textContent = '重新分析';
                    button.classList.remove('loading');
                    // 清理彩虹动画样式
                    button.style.background = '';
                    button.style.backgroundSize = '';
                    button.style.animation = '';
                    button.style.backgroundColor = '#ff6b6b';
                    button.style.color = 'white';
                    button.style.opacity = '1';
                    button.title = '上次分析失败，点击重新分析';
                    break;
                case 'network_timeout':
                    button.disabled = false;
                    button.textContent = '检查结果';
                    button.classList.remove('loading');
                    // 清理彩虹动画样式
                    button.style.background = '';
                    button.style.backgroundSize = '';
                    button.style.animation = '';
                    button.style.backgroundColor = '#ff9800';
                    button.style.color = 'white';
                    button.style.opacity = '1';
                    button.title = 'AI分析网络超时，但可能已完成。点击检查结果';
                    break;
            }
        }
        
        async function performAIAnalysis(annotation, button = null) {
            // 如果没有传入button，尝试从event.target获取（兼容原有调用方式）
            if (!button && typeof event !== 'undefined' && event.target) {
                button = event.target;
            }
            const annotationId = annotation.id;
            
            // 防止重复分析同一个注释 - 检查全局状态
            if (globalAIAnalysisState.isAnalyzing(annotationId) || analysisInProgress.has(annotationId)) {
                showNotification('⚠️ 该异动正在分析中，请等待完成', 'warning');
                return;
            }
            
            // 检查是否已存在AI分析结果
            if (annotation.algorithm_type === 'ai_analysis') {
                const userConfirm = confirm('该异动已有AI分析结果，是否重新分析？\n重新分析将替换现有的AI分析内容。');
                if (!userConfirm) {
                    return;
                }
                
                // 重新分析时，后端会自动保留原始文本，只替换AI分析部分
                console.log('[AI分析] 用户选择重新分析已有AI分析的注释');
            }
            
            // 记录正在分析的注释
            if (button) {
                analysisInProgress.set(annotationId, button);
            }
            
            // 创建AI分析Promise并注册到全局状态
            const analysisPromise = performAIAnalysisCore(annotation);
            globalAIAnalysisState.start(annotationId, analysisPromise);
            
            try {
                // 开始加载状态
                if (button) {
                    updateAIAnalysisButtonState(annotationId, 'analyzing', button);
                }
                
                // 显示分析提示
                showNotification('🤖 AI分析开始...', 'info', 2000);
                
                // 等待AI分析完成
                await analysisPromise;
                
                // 更新按钮为已完成状态
                if (button) {
                    updateAIAnalysisButtonState(annotationId, 'completed', button);
                }
                
                // 完成全局状态管理
                globalAIAnalysisState.complete(annotationId);
                
                showNotification('🤖 AI分析完成！结果已保存到注释中', 'success', 4000);
                console.log('[AI分析] 分析完成并保存');
                
            } catch (error) {
                console.error('[AI分析] 分析失败:', error);

                // 清理全局状态
                globalAIAnalysisState.complete(annotationId);

                // 智能错误分类和处理
                let errorMessage = error.message;
                let buttonState = 'error';

                if (error.message.includes('fetch')) {
                    errorMessage = '网络连接失败，请检查网络后重试';
                    buttonState = 'error';
                } else if (error.message.includes('timeout') || error.message.includes('超时')) {
                    if (error.message.includes('任务可能仍在后台运行') || error.message.includes('Dify可能已完成分析')) {
                        errorMessage = 'AI分析网络超时，但可能已完成。点击"检查结果"确认状态';
                        buttonState = 'network_timeout';
                    } else {
                        errorMessage = 'AI分析超时，服务器可能繁忙，请稍后重试';
                        buttonState = 'error';
                    }
                } else if (error.message.includes('504') || error.message.includes('Gateway Timeout')) {
                    errorMessage = 'AI分析网络超时，但Dify可能已完成分析。点击"检查结果"确认';
                    buttonState = 'network_timeout';
                } else if (error.message.includes('unauthorized') || error.message.includes('403')) {
                    errorMessage = 'API访问权限不足，请联系管理员';
                    buttonState = 'error';
                } else if (error.message.includes('连续多次获取任务状态失败')) {
                    errorMessage = '任务状态查询失败，网络可能不稳定。请稍后重试';
                    buttonState = 'error';
                }

                // 根据错误类型显示不同的通知
                if (buttonState === 'network_timeout') {
                    showNotification(`⚠️ ${errorMessage}`, 'warning', 8000);
                } else {
                    showNotification(`❌ AI分析失败: ${errorMessage}`, 'error', 6000);
                }

                // 根据错误类型设置不同的按钮状态
                updateAIAnalysisButtonState(annotationId, buttonState, button);
                
            } finally {
                // 清理分析状态记录
                analysisInProgress.delete(annotationId);
            }
        }
        
        // 专门用于弹窗的AI分析函数 - 与全局状态管理集成
        async function performAIAnalysisForPopup(annotation, buttonRef, popupRef) {
            const annotationId = annotation.id;
            
            // 检查全局状态，防止重复分析
            if (globalAIAnalysisState.isAnalyzing(annotationId)) {
                showNotification('⚠️ 该异动正在分析中，请等待完成', 'warning');
                return;
            }
            
            // 检查是否已存在AI分析结果
            if (annotation.algorithm_type === 'ai_analysis') {
                const userConfirm = confirm('该异动已有AI分析结果，是否重新分析？\n重新分析将替换现有的AI分析内容。');
                if (!userConfirm) {
                    return;
                }
                console.log('[弹窗AI分析] 用户选择重新分析已有AI分析的注释');
            }
            
            // 创建AI分析Promise
            const analysisPromise = performAIAnalysisCore(annotation);
            
            // 注册到全局状态管理
            globalAIAnalysisState.start(annotationId, analysisPromise);
            
            try {
                // 等待AI分析完成
                await analysisPromise;
                
                // 更新弹窗中的按钮状态（如果弹窗还存在）
                if (document.body.contains(buttonRef)) {
                    buttonRef.textContent = '已分析';
                    buttonRef.style.background = '#6c757d';
                    buttonRef.style.animation = '';
                    buttonRef.disabled = true;
                    buttonRef.style.opacity = '0.7';
                }
                
                // 完成状态更新
                globalAIAnalysisState.complete(annotationId);
                
                showNotification('🤖 AI分析完成！结果已保存到注释中', 'success', 4000);
                console.log('[弹窗AI分析] 分析完成并保存');
                
                // 提示用户可以关闭弹窗
                if (document.body.contains(popupRef)) {
                    showNotification('✨ 您可以继续查看其他内容，或关闭此弹窗', 'info', 3000);
                }
                
            } catch (error) {
                console.error('[弹窗AI分析] 分析失败:', error);
                
                // 恢复按钮状态（如果弹窗还存在）
                if (document.body.contains(buttonRef)) {
                    buttonRef.textContent = 'AI分析';
                    buttonRef.style.background = '#ff9800';
                    buttonRef.style.animation = '';
                    buttonRef.disabled = false;
                }
                
                // 清理全局状态
                globalAIAnalysisState.complete(annotationId);
                
                // 根据错误类型提供不同的提示
                let errorMessage = error.message;
                if (error.message.includes('fetch')) {
                    errorMessage = '网络连接失败，请检查网络后重试';
                } else if (error.message.includes('timeout') || error.message.includes('超时')) {
                    errorMessage = 'AI分析超时，服务器可能繁忙，请稍后重试';
                } else if (error.message.includes('unauthorized') || error.message.includes('403')) {
                    errorMessage = 'API访问权限不足，请联系管理员';
                }
                
                throw new Error(errorMessage);
            }
        }
        
        // 处理右键菜单AI分析
        async function performContextMenuAIAnalysis(date) {
            if (!currentTicker) {
                showNotification('⚠️ 请先选择股票后再进行AI分析', 'warning');
                return;
            }
            
            try {
                // 首先查找该日期是否已有注释
                let existingAnnotation = null;
                if (currentAnnotations) {
                    existingAnnotation = currentAnnotations.find(anno => anno.date === date);
                }
                
                if (existingAnnotation) {
                    // 如果已有注释，直接对其进行AI分析
                    console.log(`[右键AI分析] 发现已有注释 ${existingAnnotation.id}，直接分析`);
                    
                    // 检查是否已在分析中
                    if (globalAIAnalysisState.isAnalyzing(existingAnnotation.id)) {
                        showNotification('⚠️ 该日期的注释正在分析中，请等待完成', 'warning');
                        return;
                    }
                    
                    // 检查是否已有AI分析结果
                    if (existingAnnotation.algorithm_type === 'ai_analysis') {
                        const userConfirm = confirm(`${date} 已有AI分析结果，是否重新分析？\n重新分析将替换现有的AI分析内容。`);
                        if (!userConfirm) {
                            return;
                        }
                    }
                    
                    // 开始AI分析
                    showNotification('🤖 开始AI分析...', 'info', 2000);
                    await performAIAnalysis(existingAnnotation);
                } else {
                    // 如果没有注释，模拟用户手动创建注释流程：填充表单 → 保存 → AI分析
                    console.log(`[右键AI分析] ${date} 无注释，模拟用户创建流程`);
                    showNotification('📝 正在创建注释并进行AI分析...', 'info', 2000);
                    
                    // 1. 设置表单数据（复用现有的自动填充逻辑）
                    dom.addAnnotationDateInput.value = date;
                    
                    // 2. 使用现有的自动填充逻辑生成内容
                    const stockChange = getStockChangeFromChart(date);
                    if (stockChange) {
                        const companyName = currentChartData ? currentChartData.companyName : currentTicker;
                        dom.addAnnotationTextInput.value = `${companyName} ${currentTicker} 股价异动时点：${date}\n${stockChange.changeText}`;
                        console.log('[右键AI分析] 使用图表数据填充表单');
                    } else {
                        // API兜底
                        const stockData = await fetchStockDataForDate(currentTicker, date);
                        if (stockData && stockData.formatted_annotation_text) {
                            dom.addAnnotationTextInput.value = stockData.formatted_annotation_text;
                            console.log('[右键AI分析] API兜底成功');
                        } else {
                            const companyName = currentChartData ? currentChartData.companyName : currentTicker;
                            dom.addAnnotationTextInput.value = `${companyName} ${currentTicker} 股价异动时点：${date}\n股价异动待分析`;
                            console.log('[右键AI分析] 使用基础格式');
                        }
                    }
                    
                    // 3. 调用现有的保存函数（完全复用现有流程）
                    await saveNewAnnotation();
                    
                    // 4. 找到刚创建的注释并进行AI分析
                    const newAnnotation = currentAnnotations.find(anno => anno.date === date);
                    if (newAnnotation) {
                        showNotification('🤖 开始AI分析...', 'info', 2000);
                        await performAIAnalysis(newAnnotation);
                    } else {
                        throw new Error('注释创建后未找到');
                    }
                }
            } catch (error) {
                console.error('[右键AI分析] 错误:', error);
                showNotification(`❌ AI分析失败: ${error.message}`, 'error', 5000);
            }
        }
        
        // 核心AI分析逻辑 - 从原有函数中提取
        async function performAIAnalysisCore(annotation) {
            const annotationId = annotation.id;
            
            // 获取公司名称和股票代码
            const companyName = currentChartData ? currentChartData.companyName : currentTicker;
            
            // 智能准备AI分析输入数据
            // 🔧 V5.8修复：重新分析时只使用原始内容，不包含之前的AI分析
            let analysisContent;
            const hasOriginalText = annotation.original_text && annotation.original_text.trim().length > 0;
            const isManualAnnotation = annotation.type === 'manual';

            if (hasOriginalText) {
                // 如果有original_text，说明这是已经做过AI分析的注释，重新分析时只使用原始内容
                analysisContent = annotation.original_text;
                console.log('[AI分析] 使用原始内容进行重新分析，避免包含之前的AI分析');
            } else {
                // 否则使用完整的text内容（手动注释或初次分析）
                analysisContent = annotation.text;
                console.log('[AI分析] 使用完整text内容进行分析');
            }

            const hasUserContent = analysisContent && analysisContent.trim().length > 0;
            
            // 检查内容格式，决定如何处理
            let aiInput;
            
            if (hasUserContent && isStandardizedAnnotationFormat(analysisContent)) {
                // 如果用户内容已经是标准化格式，直接使用
                aiInput = analysisContent;
                console.log('[AI分析] 使用标准化格式的用户内容');
            } else if (isManualAnnotation && !hasUserContent) {
                // 如果是空的手动注释，使用图表数据计算涨跌幅（复用成熟逻辑）
                showNotification('📊 正在计算股价波动...', 'info', 2000);
                
                const stockChange = getStockChangeFromChart(annotation.date);
                if (stockChange) {
                    // 使用基于图表数据的标准格式
                    aiInput = `${companyName} ${currentTicker} 股价异动时点：${annotation.date}\n${stockChange.changeText}`;
                    console.log('[AI分析] 使用图表数据计算成功:', aiInput);
                } else {
                    // 如果图表数据计算失败，尝试API兜底
                    console.log('[AI分析] 图表数据计算失败，尝试API兜底');
                    try {
                        const stockDataResponse = await fetch(`/api/stock_data/${currentTicker}/${annotation.date}`);
                        if (stockDataResponse.ok) {
                            const stockData = await stockDataResponse.json();
                            if (stockData.success && stockData.formatted_annotation_text) {
                                aiInput = stockData.formatted_annotation_text;
                                console.log('[AI分析] API兜底成功');
                            } else {
                                throw new Error('API返回数据不完整');
                            }
                        } else {
                            throw new Error('API请求失败');
                        }
                    } catch (error) {
                        console.warn('[AI分析] API兜底也失败，使用基本格式:', error);
                        aiInput = `${companyName} ${currentTicker} 股价异动时点：${annotation.date}\n股价异动待分析`;
                    }
                }
            } else {
                // 其他情况，检查是否能优化格式
                if (analysisContent && analysisContent.trim()) {
                    // 如果有用户内容但不是标准格式，使用改进的组装方式
                    aiInput = `${companyName} ${currentTicker} 股价异动时点：${annotation.date}\n用户注释：${analysisContent}`;
                    console.log('[AI分析] 使用改进的传统格式');
                } else {
                    // 完全没有内容的情况
                    aiInput = `${companyName} ${currentTicker} 股价异动时点：${annotation.date}\n股价异动待分析`;
                    console.log('[AI分析] 使用最基本格式');
                }
            }
            
            console.log('[AI分析] 开始分析:', { 
                ticker: currentTicker, 
                date: annotation.date, 
                isManual: isManualAnnotation,
                hasUserContent: hasUserContent,
                aiInputLength: aiInput.length,
                aiInputPreview: aiInput.substring(0, 100) + (aiInput.length > 100 ? '...' : '')
            });
            showNotification('🔍 正在调用AI分析，您可以继续查看其他内容...', 'info', 5000);
            
            // 添加620秒超时控制 (比后端稍长，确保后端有机会返回超时错误)
            const timeoutPromise = new Promise((_, reject) => {
                setTimeout(() => reject(new Error('分析超时(600秒+)，请稍后重试')), 620000);
            });
            
            // 调用AI分析API (带超时)
            const aiResult = await Promise.race([
                callDifyAI(aiInput),
                timeoutPromise
            ]);
            
            if (aiResult && aiResult.result) {
                // 保存AI分析结果到数据库
                await saveAIAnalysisResult(annotation, aiResult.result);
                return aiResult.result;
            } else {
                throw new Error('AI分析返回结果为空，请检查网络连接或稍后重试');
            }
        }
        
        // 检查AI任务状态的全局功能
        async function checkAITasksStatus() {
            try {
                console.log('[AI任务检查] 开始检查所有AI任务状态...');

                const response = await fetch('/api/ai/tasks/status', {
                    method: 'GET',
                    headers: {
                        'Content-Type': 'application/json'
                    }
                });

                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
                }

                const result = await response.json();
                if (!result.success) {
                    throw new Error(result.error || '获取任务状态失败');
                }

                const stats = result.stats;
                const failedTasks = result.failed_tasks;
                const longRunningTasks = result.long_running_tasks;

                console.log('[AI任务检查] 任务状态统计:', stats);

                // 显示任务状态摘要
                let statusMessage = `📊 AI任务状态: 总计${stats.total}个任务`;
                if (stats.failed > 0) {
                    statusMessage += `, ${stats.failed}个失败`;
                }
                if (stats.processing > 0) {
                    statusMessage += `, ${stats.processing}个进行中`;
                }
                if (longRunningTasks.length > 0) {
                    statusMessage += `, ${longRunningTasks.length}个长时间运行`;
                }

                showNotification(statusMessage, stats.failed > 0 ? 'warning' : 'info', 5000);

                // 处理失败的任务
                if (failedTasks.length > 0) {
                    console.log('[AI任务检查] 发现失败任务:', failedTasks);

                    let failedMessage = `⚠️ 发现 ${failedTasks.length} 个失败的AI分析任务:\n`;
                    failedTasks.slice(0, 3).forEach((task, index) => {
                        failedMessage += `${index + 1}. ${task.ticker} (${task.date}): ${task.error_type || '未知错误'}\n`;
                    });

                    if (failedTasks.length > 3) {
                        failedMessage += `... 以及其他 ${failedTasks.length - 3} 个任务`;
                    }

                    failedMessage += '\n建议刷新页面并重新运行AI分析';

                    showNotification(failedMessage, 'error', 10000);
                }

                // 处理长时间运行的任务
                if (longRunningTasks.length > 0) {
                    console.log('[AI任务检查] 发现长时间运行任务:', longRunningTasks);

                    let longRunningMessage = `⏱️ 发现 ${longRunningTasks.length} 个长时间运行的任务 (>10分钟):\n`;
                    longRunningTasks.slice(0, 2).forEach((task, index) => {
                        const minutes = Math.floor(task.running_time / 60);
                        longRunningMessage += `${index + 1}. ${task.ticker} (${task.date}): 已运行${minutes}分钟\n`;
                    });

                    longRunningMessage += '这些任务可能遇到了问题，建议重新启动';

                    showNotification(longRunningMessage, 'warning', 8000);
                }

                return result;

            } catch (error) {
                console.error('[AI任务检查] 检查失败:', error);
                showNotification(`❌ 检查AI任务状态失败: ${error.message}`, 'error', 5000);
                throw error;
            }
        }

        // 移除了复杂的重试逻辑和异步包装函数
        // 批量分析直接使用 performAIAnalysisCore，保持简单

        // 更新批量分析进度显示
        function updateBatchProgress() {
            if (!batchAnalysisState.isProcessing) return;

            const progress = batchAnalysisState.processedCount / batchAnalysisState.totalCount;
            const percentage = Math.round(progress * 100);
            const successCount = batchAnalysisState.processedCount - batchAnalysisState.failedTasks.size;
            const failedCount = batchAnalysisState.failedTasks.size;

            // 更新批量分析按钮文本
            if (dom.batchAnalyzeBtn) {
                dom.batchAnalyzeBtn.textContent = `🤖 分析中... ${batchAnalysisState.processedCount}/${batchAnalysisState.totalCount} (${percentage}%)`;
            }

            // 更新注释列表中相关任务的状态显示
            updateAnnotationListTaskStatus();

            // 更新进度指示器
            updateBatchProgressIndicator(percentage, successCount, failedCount);

            // 显示详细进度通知（每25%进度显示一次）
            if (percentage > 0 && percentage % 25 === 0) {
                const message = `📊 批量分析进度: ${percentage}% (成功: ${successCount}, 失败: ${failedCount})`;
                showNotification(message, failedCount > 0 ? 'warning' : 'info', 3000);
            }
        }

        // 创建和更新批量分析进度指示器
        function updateBatchProgressIndicator(percentage, successCount, failedCount) {
            let indicator = document.getElementById('batch-progress-indicator');

            if (!indicator && batchAnalysisState.isProcessing) {
                // 创建进度指示器
                indicator = document.createElement('div');
                indicator.id = 'batch-progress-indicator';
                indicator.className = 'batch-progress-indicator';
                indicator.innerHTML = `
                    <div class="progress-text">批量AI分析进度</div>
                    <div class="progress-bar">
                        <div class="progress-fill" id="progress-fill"></div>
                    </div>
                    <div class="progress-stats" id="progress-stats"></div>
                `;
                document.body.appendChild(indicator);

                // 显示动画
                setTimeout(() => indicator.classList.add('visible'), 100);
            }

            if (indicator) {
                const progressFill = indicator.querySelector('.progress-fill');
                const progressStats = indicator.querySelector('.progress-stats');

                if (progressFill) {
                    progressFill.style.width = `${percentage}%`;
                }

                if (progressStats) {
                    progressStats.textContent = `${percentage}% (${successCount}成功, ${failedCount}失败)`;

                    // 根据失败情况调整颜色
                    if (failedCount > 0) {
                        progressStats.style.color = '#ffeb3b';
                    } else {
                        progressStats.style.color = 'white';
                    }
                }
            }
        }

        // 隐藏批量分析进度指示器
        function hideBatchProgressIndicator() {
            const indicator = document.getElementById('batch-progress-indicator');
            if (indicator) {
                indicator.classList.remove('visible');
                setTimeout(() => {
                    if (indicator.parentNode) {
                        indicator.parentNode.removeChild(indicator);
                    }
                }, 300);
            }
        }

        // 简化的状态显示 - 只在必要时更新
        function updateAnnotationListTaskStatus() {
            // 简化：只更新基本的进行中状态，减少复杂性
            const allAIButtons = document.querySelectorAll('.item-ai-analyze[data-annotation-id]');

            allAIButtons.forEach(button => {
                const annotationId = button.getAttribute('data-annotation-id');
                if (!annotationId) return;

                const isInCurrentBatch = batchAnalysisState.currentBatch.includes(annotationId);
                const isFailed = batchAnalysisState.failedTasks.has(annotationId);

                if (isInCurrentBatch && batchAnalysisState.isProcessing) {
                    button.textContent = '分析中...';
                    button.disabled = true;
                    button.style.backgroundColor = '#007bff';
                    button.style.color = 'white';
                    button.title = '正在进行AI分析';
                } else if (isFailed) {
                    button.textContent = '重新分析';
                    button.disabled = false;
                    button.style.backgroundColor = '#dc3545';
                    button.style.color = 'white';
                    button.title = '分析失败，点击重新分析';
                }
            });
        }

        // 当用户点击"检查结果"按钮时的处理函数
        async function handleCheckResult(annotationId, button) {
            try {
                console.log(`[AI任务检查] 检查注释 ${annotationId} 的任务状态...`);

                // 先检查全局任务状态
                const statusResult = await checkAITasksStatus();

                // 查找与当前注释相关的任务
                const allTasks = statusResult.all_tasks || {};
                let relatedTask = null;

                for (const [taskId, task] of Object.entries(allTasks)) {
                    if (task.annotation_id === annotationId) {
                        relatedTask = { taskId, ...task };
                        break;
                    }
                }

                if (relatedTask) {
                    console.log(`[AI任务检查] 找到相关任务:`, relatedTask);

                    if (relatedTask.status === 'completed') {
                        showNotification(`✅ 发现完成的任务！正在同步结果...`, 'success', 3000);
                        updateAIAnalysisButtonState(annotationId, 'completed', button);
                        // 刷新注释列表以显示最新结果
                        setTimeout(() => {
                            loadAnnotations();
                        }, 1000);
                    } else if (relatedTask.status === 'processing') {
                        const runningTime = Math.floor(relatedTask.running_time / 60);
                        showNotification(`⏳ 任务仍在运行中，已进行${runningTime}分钟。请耐心等待...`, 'info', 5000);
                    } else if (relatedTask.status === 'failed') {
                        showNotification(`❌ 确认任务失败: ${relatedTask.error}`, 'error', 5000);
                        updateAIAnalysisButtonState(annotationId, 'error', button);
                    }
                } else {
                    console.log(`[AI任务检查] 未找到注释 ${annotationId} 的相关任务`);
                    showNotification(`ℹ️ 未找到该注释的AI分析任务。可以点击"自动分析"重新开始`, 'info', 5000);
                    updateAIAnalysisButtonState(annotationId, 'ready', button);
                }

            } catch (error) {
                console.error('[AI任务检查] 检查结果失败:', error);
                showNotification(`❌ 检查结果失败: ${error.message}`, 'error', 5000);
            }
        }

        // 调用异步AI分析API
        async function callDifyAI(inputText) {
            try {
                console.log('[AI分析] 启动异步分析，输入长度:', inputText.length);
                
                // 获取当前注释的上下文信息
                const contextData = {
                    input: inputText,
                    ai_mode: getCurrentAIMode(),  // V5.8: 添加AI模式参数
                    annotation_id: 'unknown',
                    ticker: currentTicker || 'unknown',
                    date: 'unknown'
                };
                
                // 尝试从当前执行上下文获取更多信息
                if (typeof annotation !== 'undefined' && annotation) {
                    contextData.annotation_id = annotation.id;
                    contextData.date = annotation.date;
                }
                
                console.log('[AI分析] 异步请求上下文:', {
                    annotation_id: contextData.annotation_id,
                    ticker: contextData.ticker,
                    date: contextData.date,
                    input_length: inputText.length
                });
                
                // 第一步：启动异步任务
                const startResponse = await fetch('/api/ai/dify-async', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(contextData)
                });
                
                if (!startResponse.ok) {
                    let errorMessage = '启动异步任务失败';
                    try {
                        const errorData = await startResponse.json();
                        errorMessage = errorData.error || errorMessage;
                    } catch (e) {
                        errorMessage = `HTTP ${startResponse.status}: ${startResponse.statusText}`;
                    }
                    throw new Error(errorMessage);
                }
                
                const startResult = await startResponse.json();
                if (!startResult.success || !startResult.task_id) {
                    throw new Error('获取任务ID失败');
                }
                
                const taskId = startResult.task_id;
                console.log('[AI分析] 异步任务已启动，任务ID:', taskId);
                
                // 第二步：轮询任务状态直到完成
                const maxPollingTime = 660000; // 11分钟最大轮询时间
                const pollingInterval = 3000; // 每3秒查询一次
                const startTime = Date.now();
                let lastStatusUpdate = '';
                let pollFailureCount = 0;
                const maxPollFailures = 3; // 最多连续3次轮询失败

                while (Date.now() - startTime < maxPollingTime) {
                    await new Promise(resolve => setTimeout(resolve, pollingInterval));

                    try {
                        const statusResponse = await fetch(`/api/ai/task/${taskId}`, {
                            method: 'GET',
                            headers: {
                                'Content-Type': 'application/json'
                            }
                        });

                        if (!statusResponse.ok) {
                            pollFailureCount++;
                            console.warn(`[AI分析] 获取任务状态失败 (${pollFailureCount}/${maxPollFailures})，继续轮询...`);

                            if (pollFailureCount >= maxPollFailures) {
                                throw new Error('连续多次获取任务状态失败，请检查网络连接或稍后重试');
                            }
                            continue;
                        }

                        // 重置失败计数器
                        pollFailureCount = 0;

                        const statusResult = await statusResponse.json();
                        const task = statusResult.task;

                        // 显示详细的状态更新
                        const currentStatus = task.status_description || task.status;
                        const progressInfo = task.progress_description || '';
                        const runningTime = task.running_time || 0;

                        if (currentStatus !== lastStatusUpdate) {
                            console.log(`[AI分析] 状态更新: ${currentStatus} ${progressInfo} (运行${runningTime.toFixed(1)}秒)`);
                            lastStatusUpdate = currentStatus;
                        }

                        // 在开发环境显示调试信息
                        if (task.debug_info) {
                            console.log('[AI分析] 调试信息:', task.debug_info);
                        }

                        if (task.status === 'completed') {
                            console.log(`[AI分析] ✅ 异步任务成功完成！耗时: ${task.duration}秒，结果长度: ${JSON.stringify(task.result).length}`);
                            return task.result;
                        } else if (task.status === 'failed') {
                            const errorMsg = task.error || '异步任务执行失败';
                            const errorType = task.error_type || '未知错误';
                            console.error(`[AI分析] ❌ 任务失败: ${errorType} - ${errorMsg}`);

                            // 如果是网络超时错误，提供更友好的错误信息
                            if (errorMsg.includes('timeout') || errorMsg.includes('超时')) {
                                throw new Error(`AI分析网络超时，但Dify可能已完成分析。请稍后点击"重新检查"按钮确认结果。错误详情: ${errorMsg}`);
                            } else {
                                throw new Error(`AI分析失败: ${errorMsg}`);
                            }
                        }

                        // 如果状态是 'pending' 或 'processing'，继续轮询
                        // 对于长时间运行的任务，每30秒显示一次进度提醒
                        if (runningTime > 30 && runningTime % 30 < 3) {
                            console.log(`[AI分析] 💭 任务仍在进行中，已运行${Math.floor(runningTime)}秒，请耐心等待...`);
                        }

                    } catch (pollError) {
                        pollFailureCount++;
                        console.warn(`[AI分析] 轮询出错 (${pollFailureCount}/${maxPollFailures}):`, pollError.message);

                        // 如果连续失败太多次，抛出错误
                        if (pollFailureCount >= maxPollFailures) {
                            throw new Error(`轮询任务状态失败: ${pollError.message}`);
                        }
                        // 否则继续轮询，不立即抛出错误
                    }
                }

                // 超时后抛出错误，但提供恢复建议
                throw new Error('AI分析超时，任务可能仍在后台运行。建议：1) 检查网络连接；2) 稍后点击"重新检查"按钮；3) 查看日志确认任务状态');
                
            } catch (error) {
                console.error('[AI分析] 异步调用失败:', error);
                throw error;
            }
        }
        
        // AI内容预处理和验证函数
        function validateAndCleanAIAnalysis(aiResult) {
            if (!aiResult || typeof aiResult !== 'string') {
                throw new Error('AI分析结果为空或格式无效');
            }
            
            // 清理AI结果 - 移除可能的重复标记
            let cleanedResult = aiResult.trim();
            
            // 如果AI结果已经包含标记，移除它们以避免重复
            cleanedResult = cleanedResult.replace(/^🤖\s*AI深度分析：?\s*/g, '');
            cleanedResult = cleanedResult.replace(/^AI深度分析：?\s*/g, '');
            cleanedResult = cleanedResult.replace(/^#\s*AI深度分析\s*/g, '');
            
            // 清理多余的换行符
            cleanedResult = cleanedResult.replace(/^\n+/, '').replace(/\n+$/, '');
            
            // 验证内容长度（至少20个字符，最多50000个字符）
            if (cleanedResult.length < 20) {
                throw new Error('AI分析内容过短，可能分析不完整');
            }
            
            if (cleanedResult.length > 50000) {
                console.warn('[AI分析] 内容较长，可能影响显示性能');
            }
            
            console.log('[AI分析] 内容验证通过，长度:', cleanedResult.length);
            return cleanedResult;
        }

        // 保存AI分析结果到数据库 - 使用新的分离存储API
        async function saveAIAnalysisResult(originalAnnotation, aiAnalysisResult) {
            try {
                // 验证和清理AI分析内容
                const cleanedAIResult = validateAndCleanAIAnalysis(aiAnalysisResult);
                
                console.log('[AI分析] 开始保存到分离存储...');
                console.log('[AI分析] 原始注释ID:', originalAnnotation.id);
                console.log('[AI分析] 清理后内容长度:', cleanedAIResult.length);
                
                // 使用新的AI分析API端点
                const response = await fetch(`/api/annotation/${encodeURIComponent(originalAnnotation.id)}/ai-analysis`, {
                    method: 'PUT',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        ai_analysis: cleanedAIResult
                    })
                });
                
                if (!response.ok) {
                    const errorData = await response.json();
                    throw new Error(errorData.error || '保存AI分析失败');
                }
                
                const result = await response.json();
                console.log('[AI分析] 分离存储更新成功:', result);
                
                // 更新本地注释数据 - 使用新的格式：AI分析在前，算法内容在后
                const annotationIndex = currentAnnotations.findIndex(anno => anno.id === originalAnnotation.id);
                if (annotationIndex !== -1) {
                    // 构建新格式：AI分析在前，算法异动内容在后
                    const updatedText = `${cleanedAIResult}\n\n${originalAnnotation.text}`;
                    currentAnnotations[annotationIndex].text = updatedText;
                    currentAnnotations[annotationIndex].algorithm_type = 'ai_analysis'; // 标记为已AI分析
                    
                    console.log('[AI分析] 本地状态已更新，新内容长度:', updatedText.length);
                }
                
                // 刷新显示
                updateAnnotationList();
                renderCustomAnnotations(); // 刷新图表上的注释显示
                
                return result;
                
            } catch (error) {
                console.error('[AI分析] 分离存储保存失败:', error);
                
                // 增强错误信息，便于用户理解
                let userFriendlyError = error.message;
                if (error.message.includes('网络')) {
                    userFriendlyError = '网络连接失败，请检查网络后重试';
                } else if (error.message.includes('timeout')) {
                    userFriendlyError = '保存超时，请稍后重试';
                } else if (error.message.includes('format') || error.message.includes('格式')) {
                    userFriendlyError = 'AI分析结果格式异常，已自动处理';
                }
                
                // 重新抛出带有友好提示的错误
                const enhancedError = new Error(userFriendlyError);
                enhancedError.originalError = error;
                throw enhancedError;
            }
        }
        
        // 页面可见性变化时的状态管理
        document.addEventListener('visibilitychange', function() {
            if (document.visibilityState === 'visible') {
                // 页面重新可见时，检查是否有僵尸分析状态需要清理
                setTimeout(() => {
                    if (analysisInProgress.size > 0) {
                        console.log('[AI分析] 检测到可能的僵尸分析状态，正在清理...');
                        for (const [annotationId, button] of analysisInProgress) {
                            if (button && button.classList.contains('loading')) {
                                // 如果按钮仍然在加载状态，重置为准备状态
                                updateAIAnalysisButtonState(annotationId, 'ready', button);
                            }
                        }
                        analysisInProgress.clear();
                    }
                }, 1000);
            }
        });

        // 窗口关闭前清理分析状态
        window.addEventListener('beforeunload', function() {
            analysisInProgress.clear();
        });

        // 图表区域右键菜单处理
        document.addEventListener('contextmenu', function(e) {
            // 如果是注释元素或右键菜单，不处理
            if (e.target.closest('.annotation-icon') || 
                e.target.closest('.annotation-box') ||
                e.target.closest('.annotation-context-menu') ||
                e.target.closest('.chart-context-menu')) {
                return; // 让注释的右键菜单正常工作
            }
            
            // 如果是图表容器区域，显示图表右键菜单
            if (e.target.closest('#chart-container')) {
                e.preventDefault();
                showChartContextMenu(e.clientX, e.clientY, e);
                return;
            }
            
            // 其他区域禁用默认右键菜单
            e.preventDefault();
        });

        // --- V5.8.4: 时间筛选功能 ---

        /**
         * 应用时间筛选到注释列表
         * @param {Array} annotations - 待筛选的注释数组
         * @returns {Array} - 筛选后的注释数组
         */
        function applyTimeFilter(annotations) {
            if (!timeFilterState.enabled || timeFilterState.mode === 'all') {
                return annotations;
            }

            const now = new Date();
            let filterStartDate;
            let filterEndDate = now;

            if (timeFilterState.mode === 'custom') {
                // 使用自定义日期范围
                if (!timeFilterState.startDate || !timeFilterState.endDate) {
                    return annotations;
                }
                filterStartDate = new Date(timeFilterState.startDate);
                filterEndDate = new Date(timeFilterState.endDate);
            } else {
                // 使用快速选择年份
                const years = parseInt(timeFilterState.mode.replace('y', ''));
                filterStartDate = new Date(now);
                filterStartDate.setFullYear(filterStartDate.getFullYear() - years);
            }

            // 筛选注释
            return annotations.filter(anno => {
                const annoDate = new Date(anno.date);
                return annoDate >= filterStartDate && annoDate <= filterEndDate;
            });
        }

        /**
         * 更新时间筛选状态信息显示
         */
        function updateTimeFilterInfo() {
            if (!dom.timeFilterInfo) return;

            const filterStatus = dom.timeFilterInfo.querySelector('.filter-status');
            if (!filterStatus) return;

            let statusText = '';
            let filteredCount = 0;

            if (timeFilterState.enabled && timeFilterState.mode !== 'all') {
                // 计算筛选后的数量
                const enabledAnnotationTypes = new Set();
                if (dom.priceVolumeCheck && dom.priceVolumeCheck.checked) enabledAnnotationTypes.add('price_volume');
                if (dom.volumePriceCheck && dom.volumePriceCheck.checked) enabledAnnotationTypes.add('volume_stable_price');
                if (dom.priceOnlyCheck && dom.priceOnlyCheck.checked) enabledAnnotationTypes.add('price_only');
                if (dom.volumeOnlyCheck && dom.volumeOnlyCheck.checked) enabledAnnotationTypes.add('volume_only');

                let visibleAnnotations = currentAnnotations.filter(anno =>
                    enabledAnnotationTypes.has(anno.type) ||
                    anno.type === 'manual' ||
                    anno.algorithm_type === 'ai_analysis'  // 修复：检查algorithm_type而不是type
                );

                const filteredAnnotations = applyTimeFilter(visibleAnnotations);
                filteredCount = filteredAnnotations.length;

                if (timeFilterState.mode === 'custom') {
                    statusText = `📊 ${timeFilterState.startDate} 至 ${timeFilterState.endDate} (${filteredCount}条)`;
                } else {
                    const years = timeFilterState.mode.replace('y', '');
                    statusText = `📊 最近${years}年 (${filteredCount}条)`;
                }
            } else {
                statusText = `📊 显示全部注释 (${currentAnnotations.length}条)`;
            }

            filterStatus.textContent = statusText;
        }

        /**
         * 初始化时间筛选控制器
         */
        function initTimeFilter() {
            if (!dom.timeRangeQuickSelect) return;

            // 快速选择下拉菜单变化事件
            dom.timeRangeQuickSelect.addEventListener('change', (e) => {
                const selectedMode = e.target.value;

                if (selectedMode === 'custom') {
                    // 显示自定义日期选择器
                    dom.timeFilterCustom.style.display = 'flex';

                    // 设置默认日期范围（最近1年）
                    const now = new Date();
                    const oneYearAgo = new Date(now);
                    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);

                    dom.endDateInput.valueAsDate = now;
                    dom.startDateInput.valueAsDate = oneYearAgo;

                    // 不立即应用筛选，等待用户点击"应用"按钮
                    timeFilterState.enabled = false;
                } else {
                    // 隐藏自定义日期选择器
                    dom.timeFilterCustom.style.display = 'none';

                    // 更新筛选状态
                    timeFilterState.mode = selectedMode;
                    timeFilterState.enabled = (selectedMode !== 'all');
                    timeFilterState.startDate = null;
                    timeFilterState.endDate = null;

                    // 立即应用筛选
                    updateAnnotationList();
                    updateTimeFilterInfo();
                    updateBatchControls(); // V5.8.4: 更新批量控制状态，确保全选按钮正确反映筛选结果

                    showNotification(
                        selectedMode === 'all' ? '已清除时间筛选' : `已筛选最近${selectedMode.replace('y', '')}年的注释`,
                        'success',
                        2000
                    );
                }
            });

            // 自定义日期应用按钮
            if (dom.applyCustomDateBtn) {
                dom.applyCustomDateBtn.addEventListener('click', () => {
                    const startDate = dom.startDateInput.value;
                    const endDate = dom.endDateInput.value;

                    if (!startDate || !endDate) {
                        showNotification('请选择开始和结束日期', 'warning', 2000);
                        return;
                    }

                    if (new Date(startDate) > new Date(endDate)) {
                        showNotification('开始日期不能晚于结束日期', 'warning', 2000);
                        return;
                    }

                    // 更新筛选状态
                    timeFilterState.mode = 'custom';
                    timeFilterState.enabled = true;
                    timeFilterState.startDate = startDate;
                    timeFilterState.endDate = endDate;

                    // 应用筛选
                    updateAnnotationList();
                    updateTimeFilterInfo();
                    updateBatchControls(); // V5.8.4: 更新批量控制状态，确保全选按钮正确反映筛选结果

                    showNotification(`已筛选 ${startDate} 至 ${endDate} 的注释`, 'success', 2000);
                });
            }

            // 初始化时间筛选信息显示
            updateTimeFilterInfo();
        }

        // --- 启动 ---
        document.addEventListener('DOMContentLoaded', init);