/**
 * **通用登录会话**：适配器只提供「拿一个授权链接」和「问一次结果」两步，
 * 宿主负责会话状态、过期与落盘。
 *
 * 为什么抽象成两步而不是让适配器自己轮询：
 *
 *   1. 轮询的节奏由**界面**决定（用户点了「刷新登录状态」才问一次），
 *      适配器不该自己起定时器 —— 用户关掉页面后还在后台打上游是浪费；
 *   2. `state` / `device_code` 这类中间凭据**只留在宿主进程内**，
 *      永远不回浏览器（浏览器只拿到 authUrl 与展示用文案）。
 *
 * 三种平台的形态都能塞进这个接口：
 *   - OpenCode：设备码（userCode + verificationUrl）
 *   - WorkBuddy：external-link（authUrl + state）
 *   - Qoder：设备码 + PKCE（authUrl + state）
 */

                                                    

/** 发起登录的产物。 */
                                   
                      
                 
                                  
                   
                
                      
                                
                
 

/** 问一次登录结果。 */
                                  
                                                    
                             
                  
                                
                                  
                                   
                
 

/** 适配器可选实现的登录能力。 */
                                  
                             
                                                     
                                      
                                                                   
 


//# sourceURL=D:\AI\DeepseekPlugin\dsh-multi-agent-gateway\src\core\login.ts